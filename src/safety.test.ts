import { describe, expect, test } from "bun:test";
import { memoryIo } from "./io";
import { runCommand } from "./main";
import { createMcpHandler } from "./mcp";
import { resolveSettings } from "./profile";
import { EVM_KEY, fakeApi, SOL, tempEnv } from "./testing";
import { TRADING_API } from "./tree";

// What stands between a command and a signature: the USD limit, the
// confirmation, strict flags and dry runs. Every rejection here is paired
// with a run of the same fixture that goes through.

const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;

const quote = (overrides: Record<string, unknown> = {}) => ({
    expiresAt: new Date(Date.now() + 25_000).toISOString(),
    fee: { amount: "0.05", symbol: "USD" },
    message: Buffer.from("quote bytes").toString("base64"),
    pay: { amount: "5", symbol: "USD" },
    receive: { amount: "0.04", minimum: "0.039", symbol: "SOL" },
    signer: { address: "typed-evm-address", signWith: "evm" },
    transaction: "dHg=",
    usdValue: "5",
    ...overrides,
});

const swapRoutes = (quoteOf: () => unknown = () => quote()) =>
    fakeApi({
        "GET /swap/ID1": () => ({
            final: true,
            id: "ID1",
            status: "completed",
        }),
        "GET /tokens": () => ({
            tokens: [
                { address: SOL, chainId: 900, symbol: "SOL", verified: true },
            ],
        }),
        "POST /swap": (body) =>
            (body as { dryRun?: boolean }).dryRun
                ? {
                      account: "acct",
                      dryRun: true,
                      id: "ID1",
                      type: "swap",
                      valid: true,
                  }
                : { final: false, id: "ID1", status: "pending" },
        "POST /swap/quote": quoteOf,
    });

const env = (extra: Record<string, string> = {}) =>
    tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY, ...extra });

const submitted = (calls: { path: string }[]) =>
    calls.filter((call) => call.path === "/swap").length;

describe("signing", () => {
    test("--yes quotes, signs, submits and waits until final", async () => {
        const { api, calls } = swapRoutes();
        const result = await runCommand(["buy", "SOL", "5", "--yes"], {
            api,
            env: env(),
        });
        expect(result.exitCode).toBe(0);
        expect(result.output).toMatchObject({
            final: true,
            quote: { pay: { amount: "5" }, usdValue: "5" },
            status: "completed",
        });
        const submit = calls.find((call) => call.path === "/swap")
            ?.body as Record<string, unknown>;
        expect(submit.transaction).toBe("dHg=");
        expect(submit.signature).toMatch(EVM_SIGNATURE);
        expect(submit.dryRun).toBeUndefined();
        expect(JSON.stringify(result.output)).not.toContain("dHg=");
    });

    test("--dry-run signs and has the API check it, without a prompt or a wait", async () => {
        const { api, calls } = swapRoutes();
        const result = await runCommand(["buy", "SOL", "5", "--dry-run"], {
            api,
            env: env(),
        });
        expect(result).toMatchObject({
            exitCode: 0,
            output: { dryRun: true, valid: true },
        });
        expect(calls.find((call) => call.path === "/swap")?.body).toMatchObject(
            {
                dryRun: true,
            }
        );
        expect(calls.some((call) => call.path === "/swap/ID1")).toBe(false);
    });

    test("with nobody at the terminal and no --yes, it stops with the quote and signs nothing", async () => {
        const { api, calls } = swapRoutes();
        const result = await runCommand(["buy", "SOL", "5"], {
            api,
            env: env(),
        });
        expect(result).toMatchObject({
            exitCode: 1,
            output: {
                error: {
                    code: "confirmation_required",
                    details: { quote: { pay: { amount: "5" } } },
                },
            },
        });
        expect(submitted(calls)).toBe(0);
    });

    test("a person at the terminal is asked; no means nothing is signed", async () => {
        const asked: string[] = [];
        const ask = (answer: boolean) =>
            memoryIo({
                confirm: (question) => {
                    asked.push(question);
                    return Promise.resolve(answer);
                },
                terminal: true,
            });
        const declined = swapRoutes();
        const io = ask(false);
        const result = await runCommand(["buy", "SOL", "5"], {
            api: declined.api,
            env: env(),
            io,
        });
        expect(result.output).toMatchObject({ error: { code: "cancelled" } });
        expect(submitted(declined.calls)).toBe(0);
        expect(io.err.join("")).toContain('"usdValue": "5"');
        expect(asked[0]).toContain("fake.test");

        const accepted = swapRoutes();
        expect(
            await runCommand(["buy", "SOL", "5"], {
                api: accepted.api,
                env: env(),
                io: ask(true),
            })
        ).toMatchObject({ exitCode: 0, output: { final: true } });
        expect(submitted(accepted.calls)).toBe(1);
    });

    test("an agent in a terminal is never prompted", async () => {
        const { api, calls } = swapRoutes();
        const result = await runCommand(["buy", "SOL", "5"], {
            api,
            env: env({ CLAUDECODE: "1" }),
            io: memoryIo({ terminal: true }),
        });
        expect(result.output).toMatchObject({
            error: { code: "confirmation_required" },
        });
        expect(submitted(calls)).toBe(0);
    });

    test("a quote that expired before signing is quoted again", async () => {
        let quotes = 0;
        const { api, calls } = swapRoutes(() => {
            quotes += 1;
            return quote(
                quotes === 1
                    ? { expiresAt: new Date(Date.now() - 1000).toISOString() }
                    : {}
            );
        });
        const result = await runCommand(["buy", "SOL", "5", "--yes"], {
            api,
            env: env(),
        });
        expect(result.exitCode).toBe(0);
        expect(quotes).toBe(2);
        expect(submitted(calls)).toBe(1);
    });

    test("the lowest limit wins: --max-usd can't raise GUM_MAX_TRADE_USD or the profile's", async () => {
        const allowed = swapRoutes();
        expect(
            (
                await runCommand(
                    ["buy", "SOL", "5", "--yes", "--max-usd", "5"],
                    {
                        api: allowed.api,
                        env: env({ GUM_MAX_TRADE_USD: "10" }),
                    }
                )
            ).exitCode
        ).toBe(0);

        const { api, calls } = swapRoutes();
        const result = await runCommand(
            ["buy", "SOL", "5", "--yes", "--max-usd", "100"],
            { api, env: env({ GUM_MAX_TRADE_USD: "1" }) }
        );
        expect(result.output).toMatchObject({ error: { code: "over_limit" } });
        expect(submitted(calls)).toBe(0);

        const profiled = env();
        const settings = resolveSettings(profiled);
        expect(settings.profileMaxUsd).toBeUndefined();
        await runCommand(
            ["auth", "login", "--max-usd", "2", "--profile", "capped"],
            {
                env: { ...profiled, GUM_EVM_PRIVATE_KEY: "" },
            }
        );
        const capped = swapRoutes();
        expect(
            (
                await runCommand(
                    [
                        "buy",
                        "SOL",
                        "5",
                        "--yes",
                        "--max-usd",
                        "100",
                        "--profile",
                        "capped",
                    ],
                    { api: capped.api, env: profiled }
                )
            ).output
        ).toMatchObject({ error: { code: "over_limit" } });
        expect(submitted(capped.calls)).toBe(0);
    });

    test("with a limit set, a quote without usdValue is never signed", async () => {
        const { api, calls } = swapRoutes(() => quote({ usdValue: null }));
        const result = await runCommand(
            ["sell", "SOL", "1", "--yes", "--max-usd", "10"],
            { api, env: env() }
        );
        expect(result.output).toMatchObject({ error: { code: "over_limit" } });
        expect(submitted(calls)).toBe(0);
    });

    test("a quote meant for another signer is refused", async () => {
        const { api, calls } = swapRoutes(() =>
            quote({
                signer: {
                    address: "SomeoneElse111111111111111111111111111111",
                    signWith: "solana",
                },
            })
        );
        const result = await runCommand(["buy", "SOL", "5", "--yes"], {
            api,
            env: env(),
        });
        expect(result.output).toMatchObject({
            error: { code: "signer_mismatch" },
        });
        expect(submitted(calls)).toBe(0);
    });

    test("buy makes exactly the calls swaps create makes", async () => {
        const shortcut = swapRoutes();
        await runCommand(["buy", "SOL", "5", "--yes"], {
            api: shortcut.api,
            env: env(),
        });
        const full = swapRoutes();
        await runCommand(
            [
                "swaps",
                "create",
                "--side",
                "buy",
                "--token",
                "SOL",
                "--amount",
                "5",
                "--yes",
            ],
            { api: full.api, env: env() }
        );
        expect(shortcut.calls).toEqual(full.calls);
    });

    test("withdraw passes USD through and quotes for the destination chain", async () => {
        const { api, calls } = fakeApi({
            "POST /withdraw": () => ({
                final: false,
                id: "W1",
                status: "pending",
            }),
            "POST /withdraw/quote": () =>
                quote({
                    amount: { amount: "50", symbol: "USD" },
                    chainId: 8453,
                    destination: "0x0000000000000000000000000000000000000001",
                    usdValue: "50",
                    warnings: [],
                }),
        });
        const result = await runCommand(
            [
                "withdraw",
                "50",
                "usd",
                "--to",
                "0x0000000000000000000000000000000000000001",
                "--chain",
                "8453",
                "--yes",
                "--no-wait",
            ],
            { api, env: env() }
        );
        expect(result).toMatchObject({ exitCode: 0, output: { id: "W1" } });
        expect(calls[0]?.body).toMatchObject({
            amount: "50",
            chainId: 8453,
            destination: "0x0000000000000000000000000000000000000001",
            token: "USD",
        });
    });
});

const SAMPLES: Record<string, string> = {
    amount: "5",
    chainId: "8453",
    destination: "0x0000000000000000000000000000000000000001",
    side: "buy",
    token: "USD",
};

/** The shortest valid argv for a signed command: every required input, nothing else. */
const minimal = (path: string[]) => {
    const command = TRADING_API.commands.find(
        (candidate) => candidate.path.join(" ") === path.join(" ")
    );
    const inputs = command?.inputs.filter((input) => input.required) ?? [];
    return [
        ...path,
        ...inputs
            .filter((input) => input.position !== undefined)
            .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
            .map((input) => SAMPLES[input.field] ?? "x"),
        ...inputs
            .filter((input) => input.position === undefined)
            .flatMap((input) => [
                `--${input.flag}`,
                SAMPLES[input.field] ?? "x",
            ]),
    ];
};

describe("every signed command refuses a mistyped safety flag before any call", () => {
    const signed = TRADING_API.commands
        .filter((command) => command.run.kind === "signed")
        .map((command) => [command.path]);
    expect(signed.length).toBeGreaterThanOrEqual(5);

    test.each(signed)("%p", async (path) => {
        for (const extra of [
            ["--dry_run"],
            ["--dryRun"],
            ["--maxUsd", "10"],
            ["--max-usd="],
            ["--max-usd", " "],
            ["--max-usd"],
            ["--dry-run=yes"],
            ["--max-usd", "1", "--max-usd", "2"],
            ["--yes", "--yes"],
        ]) {
            const { api, calls } = fakeApi({});
            const result = await runCommand([...minimal(path), ...extra], {
                api,
                env: env(),
            });
            expect(result.exitCode).toBe(1);
            expect(result.output).toMatchObject({
                error: { code: "invalid_request" },
            });
            expect(calls).toHaveLength(0);
        }
    });
});

describe("MCP signing", () => {
    test.each([
        {
            input: { amount: "5", chainId: 900, side: "buy", token: SOL },
            name: "trade",
            route: "/swap",
        },
        {
            input: {
                amount: "5",
                chainId: 8453,
                destination: "0x0000000000000000000000000000000000000001",
                token: "USD",
            },
            name: "withdraw",
            route: "/withdraw",
        },
    ])(
        "$name rejects invalid dryRun values before any API call",
        async ({ name, route, input }) => {
            const environment = env({ GUM_MAX_TRADE_USD: "10" });
            const invoke = async (dryRun: unknown) => {
                const { api, calls } = fakeApi({
                    [`POST ${route}/quote`]: () => quote(),
                    [`POST ${route}`]: () => ({ final: true, id: "ID1" }),
                    [`GET ${route}/ID1`]: () => ({ final: true, id: "ID1" }),
                });
                const handle = createMcpHandler(
                    {
                        agent: "mcp",
                        api,
                        emit: () => undefined,
                        env: environment,
                        interactive: false,
                        io: memoryIo(),
                        settings: resolveSettings(environment),
                    },
                    "0"
                );
                const response = (await handle({
                    id: 1,
                    method: "tools/call",
                    params: { arguments: { ...input, dryRun }, name },
                })) as {
                    result: { content: { text: string }[]; isError?: boolean };
                };
                return { calls, result: response.result };
            };

            for (const dryRun of [true, false]) {
                const valid = await invoke(dryRun);
                expect(valid.result.isError).toBeUndefined();
                const submits = valid.calls.filter(
                    (entry) => entry.path === route
                );
                expect(submits).toHaveLength(1);
                const body = submits[0]?.body as
                    | { dryRun?: boolean }
                    | undefined;
                expect(body?.dryRun).toBe(dryRun ? true : undefined);
            }
            for (const dryRun of [null, "true", 0, {}, []]) {
                const invalid = await invoke(dryRun);
                expect(invalid.result.isError).toBe(true);
                expect(invalid.result.content[0]?.text).toContain(
                    "invalid_request"
                );
                expect(invalid.result.content[0]?.text).toContain("dryRun");
                expect(invalid.calls).toHaveLength(0);
            }
        }
    );

    const call = (
        environment: Record<string, string | undefined>,
        input: unknown
    ) => {
        const routes = swapRoutes();
        const handle = createMcpHandler(
            {
                agent: "mcp",
                api: routes.api,
                emit: () => undefined,
                env: environment,
                interactive: false,
                io: memoryIo(),
                settings: resolveSettings(environment),
            },
            "0"
        );
        return {
            calls: routes.calls,
            response: handle({
                id: 1,
                method: "tools/call",
                params: { arguments: input, name: "trade" },
            }) as Promise<{
                result: { content: { text: string }[]; isError?: boolean };
            }>,
        };
    };
    const args = { amount: "5", side: "buy", token: "SOL" };

    test("trade needs a USD limit on the server; a dry run doesn't", async () => {
        const capped = call(env({ GUM_MAX_TRADE_USD: "10" }), args);
        expect((await capped.response).result.isError).toBeUndefined();
        expect(submitted(capped.calls)).toBe(1);

        const open = call(env(), args);
        const refused = await open.response;
        expect(refused.result.isError).toBe(true);
        expect(refused.result.content[0]?.text).toContain("limit_required");
        expect(open.calls).toHaveLength(0);

        const dry = call(env(), { ...args, dryRun: true });
        expect((await dry.response).result.isError).toBeUndefined();
        expect(
            dry.calls.find((entry) => entry.path === "/swap")?.body
        ).toMatchObject({
            dryRun: true,
        });
    });

    test("an argument the tool doesn't have (dry_run) is refused with zero calls", async () => {
        const { calls, response } = call(env({ GUM_MAX_TRADE_USD: "10" }), {
            ...args,
            dry_run: true,
        });
        const answer = await response;
        expect(answer.result.isError).toBe(true);
        expect(answer.result.content[0]?.text).toContain("dry_run");
        expect(calls).toHaveLength(0);
    });
});
