import { describe, expect, test } from "bun:test";
import { memoryIo } from "./io";
import { runCommand, servesMcp } from "./main";
import { commandDocs, rank } from "./search";
import { EVM_KEY, fakeApi, SOL, SOLANA_ACCOUNT, tempEnv } from "./testing";

const BUY_USAGE = /^gumag buy <token> <usd>/;
const SWAPS_QUOTE_USAGE = /^gumag swaps quote/;
const HISTORY_DRY_RUN_URL =
    /^http:\/\/fake\.test\/v1\/history\/0x[0-9a-fA-F]{40}\?type=swap$/;

const chains = () =>
    fakeApi({
        "GET /chains": () => ({ chains: [{ chainId: 900, name: "Solana" }] }),
    });

describe("output", () => {
    test("pretty on a terminal, one line when piped or run by an agent", async () => {
        const terminal = memoryIo({ stdoutTerminal: true });
        await runCommand(["chains", "list"], {
            api: chains().api,
            env: tempEnv(),
            io: terminal,
        });
        expect(terminal.out.join("")).toContain('\n  "chains": [');

        const piped = memoryIo();
        await runCommand(["chains", "list"], {
            api: chains().api,
            env: tempEnv(),
            io: piped,
        });
        expect(piped.out).toEqual([
            '{"chains":[{"chainId":900,"name":"Solana"}]}\n',
        ]);

        const agent = memoryIo({ stdoutTerminal: true });
        await runCommand(["chains", "list"], {
            api: chains().api,
            env: tempEnv({ CLAUDECODE: "1" }),
            io: agent,
        });
        expect(agent.out[0]?.split("\n")).toHaveLength(2);

        const forced = memoryIo();
        await runCommand(["chains", "list", "--pretty"], {
            api: chains().api,
            env: tempEnv(),
            io: forced,
        });
        expect(forced.out.join("")).toContain('\n  "chains"');
    });

    test("failures are JSON on stderr with exit code 1, and nothing on stdout", async () => {
        const io = memoryIo();
        const result = await runCommand(["bogus"], {
            api: fakeApi({}).api,
            env: tempEnv(),
            io,
        });
        expect(result.exitCode).toBe(1);
        expect(io.out).toEqual([]);
        expect(JSON.parse(io.err.join(""))).toMatchObject({
            error: { code: "unknown_command" },
        });
    });

    test("a trade without a wallet says how to get one", async () => {
        const result = await runCommand(["buy", "SOL", "5", "--yes"], {
            api: fakeApi({}).api,
            env: tempEnv(),
        });
        expect(result.output).toMatchObject({
            error: {
                code: "no_wallet",
                message: expect.stringContaining("gumag auth login"),
            },
        });
    });
});

describe("help and discovery", () => {
    test.each(["--help", "swaps", "bogus"])(
        "agent discovery distinguishes unsigned quotes from signed dry-runs: %s",
        async (word) => {
            const { output } = await runCommand([word], {
                env: tempEnv({ GUMAG_AGENT: "1" }),
            });
            const result = output as {
                agentCommandDiscovery?: string;
                error?: { details?: { agentCommandDiscovery?: string } };
            };
            const discovery =
                result.agentCommandDiscovery ??
                result.error?.details?.agentCommandDiscovery;
            expect(discovery).toContain("For quotes without signing");
            expect(discovery).toContain("gumag swaps quote");
            expect(discovery).toContain("gumag withdrawals quote");
            expect(discovery).toContain("--dry-run still signs locally");
            expect(discovery).toContain("sends the signature to the API");
            expect(discovery).toContain("does not execute");
        }
    );

    test("help is JSON; agents also get the command discovery block", async () => {
        const person = await runCommand([], { env: tempEnv() });
        expect(person.exitCode).toBe(0);
        expect(person.output).toMatchObject({
            name: "gumag",
            tasks: expect.arrayContaining([
                expect.objectContaining({
                    command: expect.stringMatching(BUY_USAGE),
                }),
            ]),
        });
        expect(person.output).not.toHaveProperty("agentCommandDiscovery");
        const agent = await runCommand(["--help"], {
            env: tempEnv({ CLAUDECODE: "1" }),
        });
        expect(agent.output).toMatchObject({
            agentCommandDiscovery: expect.stringContaining("gumag cli search"),
        });
    });

    test("a typo names the command that was probably meant", async () => {
        expect(
            await runCommand(["swaps", "quotes"], { env: tempEnv() })
        ).toMatchObject({
            exitCode: 1,
            output: {
                error: {
                    message:
                        "gumag swaps has no quotes. Did you mean `gumag swaps quote`?",
                },
            },
        });
    });

    test("help for a group, a command and `help <command>`", async () => {
        expect(
            (await runCommand(["swaps"], { env: tempEnv() })).output
        ).toMatchObject({
            command: "gumag swaps",
            commands: expect.arrayContaining([
                expect.objectContaining({
                    command: expect.stringMatching(SWAPS_QUOTE_USAGE),
                }),
            ]),
        });
        const help = await runCommand(["swaps", "create", "--help"], {
            env: tempEnv(),
        });
        expect(help.output).toMatchObject({
            flags: expect.arrayContaining([
                expect.objectContaining({ flag: "--yes" }),
                expect.objectContaining({
                    flag: "--side",
                    values: ["buy", "sell"],
                }),
            ]),
            schema: "gumag schema swaps create",
        });
        expect(
            (await runCommand(["help", "swaps", "create"], { env: tempEnv() }))
                .output
        ).toEqual(help.output);
    });

    test("schema gives types, the operation behind a command and what a shortcut fixes", async () => {
        const { output } = await runCommand(["schema", "buy"], {
            env: tempEnv(),
        });
        expect(output).toMatchObject({
            arguments: [
                { argument: "<token>", field: "token", resolve: "token" },
                { argument: "<amount>", field: "amount", type: "string" },
            ],
            fixed: { side: "buy" },
            httpMethod: "POST",
            operationId: "quoteSwap",
            run: { kind: "signed", submits: "executeSwap" },
            shortcutOf: "gumag swaps create",
        });
        expect(
            (await runCommand(["schema", "nope"], { env: tempEnv() })).exitCode
        ).toBe(1);
        const longSchema = await runCommand(["schema", "long"], {
            env: tempEnv(),
        });
        expect(longSchema.exitCode).toBe(0);
        expect(longSchema.output).toMatchObject({
            fixed: { side: "buy", sizeCurrency: "USD" },
            httpMethod: "POST",
            operationId: "quotePerpsOrder",
            run: { kind: "signed", submits: "executePerpsOrder" },
            shortcutOf: "gumag perps orders create",
        });
    });

    test("version names the API it was generated from", async () => {
        expect(
            (await runCommand(["--version"], { env: tempEnv() })).output
        ).toMatchObject({
            api: "GUM Trading API 1.0.0",
            version: expect.any(String),
        });
    });

    test("completion and agents-md print text for files", async () => {
        const io = memoryIo();
        await runCommand(["completion", "bash"], { env: tempEnv(), io });
        expect(io.out.join("")).toContain(
            "complete -o default -F _gumag gumag gumx"
        );
        expect(io.out.join("")).toContain('"swaps create") candidates="');
        const fish = memoryIo();
        await runCommand(["completion", "fish"], { env: tempEnv(), io: fish });
        expect(fish.out.join("")).toContain(
            "__fish_seen_subcommand_from swaps; and __fish_seen_subcommand_from create"
        );
        const md = memoryIo();
        await runCommand(["cli", "agents-md"], { env: tempEnv(), io: md });
        expect(md.out.join("")).toStartWith("## GUM (gumag)");
    });

    test("mcp serves; asked for help or a version, or given extras, it answers instead", () => {
        expect(servesMcp(["mcp"])).toBe(true);
        expect(servesMcp(["mcp", "--help=false"])).toBe(true);
        for (const argv of [
            ["mcp", "--help"],
            ["mcp", "--version"],
            ["mcp", "--help=yes"],
            ["mcp", "--verbose"],
            ["mcp", "extra"],
        ]) {
            expect(servesMcp(argv)).toBe(false);
        }
    });
});

describe("search", () => {
    test.each([
        ["withdraw usdc to base", "gumag withdraw "],
        ["buy some sol", "gumag buy "],
        ["is my trade done", "gumag swaps get "],
        ["where do I send funds", "gumag deposit"],
        ["withdrwa usdc", "gumag withdraw"],
        ["list chains", "gumag chains list"],
        ["switch profile", "gumag auth use"],
        ["close sol position", "gumag perps close "],
        ["my perps positions", "gumag perps positions"],
        ["open perps orders", "gumag perps orders list"],
        ["set sol leverage", "gumag perps leverage set "],
    ])("%s → %s", (query, command) => {
        expect(rank(query, commandDocs())[0]?.command).toStartWith(command);
    });

    test("a signed submit is never offered; an operation only the live API has comes as an api call", async () => {
        const { api } = fakeApi({
            "GET /openapi.json": () => ({
                paths: {
                    "/prices/{address}": {
                        get: {
                            operationId: "getPriceHistory",
                            parameters: [
                                { in: "path", name: "address", required: true },
                            ],
                            summary: "Price history of an account's holdings",
                        },
                    },
                    "/swap": {
                        post: {
                            operationId: "executeSwap",
                            requestBody: {
                                content: {
                                    "application/json": {
                                        schema: {
                                            properties: {
                                                signature: {},
                                                transaction: {},
                                            },
                                            required: [
                                                "transaction",
                                                "signature",
                                            ],
                                        },
                                    },
                                },
                            },
                            summary: "Submit a signed quote",
                        },
                    },
                },
            }),
        });
        const signed = await runCommand(
            ["cli", "search", "submit", "signed", "quote"],
            {
                api,
                env: tempEnv(),
            }
        );
        expect(JSON.stringify(signed.output)).not.toContain("executeSwap");
        const live = await runCommand(["search", "price history"], {
            api,
            env: tempEnv(),
        });
        expect(
            (live.output as { results: { command: string }[] }).results[0]
        ).toMatchObject({
            command: "gumag api getPriceHistory --address <address>",
        });
    });
});

describe("api", () => {
    const env = () => tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY });

    test("calls an operation by id, typing flags from the spec", async () => {
        const { api, calls } = fakeApi({
            "POST /swap/quote": (body) => body,
        });
        const result = await runCommand(
            [
                "api",
                "quoteSwap",
                "--address",
                SOLANA_ACCOUNT,
                "--amount",
                "100000000.000000001",
                "--chain",
                "900",
                "--side",
                "sell",
                "--token",
                SOL,
            ],
            { api, env: env() }
        );
        expect(result.output).toEqual({
            address: SOLANA_ACCOUNT,
            amount: "100000000.000000001",
            chainId: 900,
            side: "sell",
            token: SOL,
        });
        expect(calls).toHaveLength(1);
    });

    test("--dry-run prints the request; an address path defaults to your wallet", async () => {
        const { api, calls } = fakeApi({});
        const result = await runCommand(
            ["api", "getHistory", "--type", "swap", "--dry-run"],
            { api, env: env() }
        );
        expect(result.output).toMatchObject({
            dryRun: true,
            method: "GET",
            url: expect.stringMatching(HISTORY_DRY_RUN_URL),
        });
        expect(calls).toHaveLength(0);
    });

    test("refuses signed submits, streams and fields the operation doesn't take", async () => {
        const { api, calls } = fakeApi({});
        expect(
            (await runCommand(["api", "executeSwap"], { api, env: env() }))
                .output
        ).toMatchObject({ error: { code: "use_signed_command" } });
        expect(
            (
                await runCommand(["api", "streamSwap", "--id", "x"], {
                    api,
                    env: env(),
                })
            ).output
        ).toMatchObject({
            error: {
                code: "use_watch_command",
                message: expect.stringContaining("gumag swaps watch"),
            },
        });
        expect(
            (
                await runCommand(["api", "listChains", "--colour", "blue"], {
                    api,
                    env: env(),
                })
            ).output
        ).toMatchObject({
            error: {
                message: "listChains has no --colour. It takes no flags.",
            },
        });
        expect(calls).toHaveLength(0);
    });
});
