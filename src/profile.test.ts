import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { memoryIo } from "./io";
import { runCommand } from "./main";
import { configDirOf, keyPathOf, limitOf, resolveSettings } from "./profile";
import { EVM_KEY, tempEnv } from "./testing";
import { evmWallet, newKey } from "./wallet";

describe("auth login", () => {
    test.each([false, true])(
        "an invalid limit leaves no wallet or config and permits a corrected retry (import: %p)",
        async (imported) => {
            const login = (
                environment: ReturnType<typeof tempEnv>,
                limit: string
            ) =>
                runCommand(
                    [
                        "auth",
                        "login",
                        "--profile",
                        "bot",
                        "--max-usd",
                        limit,
                        ...(imported ? ["--import"] : []),
                    ],
                    { env: environment, io: memoryIo({ stdin: EVM_KEY }) }
                );
            expect(await login(tempEnv(), "25")).toMatchObject({
                exitCode: 0,
                output: { maxTradeUsd: 25, profile: "bot" },
            });

            const env = tempEnv();
            expect(await login(env, "-1")).toMatchObject({
                exitCode: 1,
                output: { error: { code: "invalid_request" } },
            });
            const dir = configDirOf(env);
            expect(existsSync(join(dir, "keys", "bot.json"))).toBe(false);
            expect(existsSync(join(dir, "config.json"))).toBe(false);
            expect(await login(env, "25")).toMatchObject({
                exitCode: 0,
                output: { maxTradeUsd: 25, profile: "bot" },
            });
        }
    );

    test("creates a key only you can read, makes the profile the default, and never replaces it", async () => {
        const env = tempEnv();
        const io = memoryIo();
        const login = await runCommand(
            [
                "auth",
                "login",
                "--profile",
                "bot",
                "--network",
                "devnet",
                "--max-usd",
                "25",
            ],
            { env, io }
        );
        expect(login).toMatchObject({
            exitCode: 0,
            output: {
                kind: "solana",
                maxTradeUsd: 25,
                network: "devnet",
                profile: "bot",
            },
        });
        const { saved } = login.output as { saved: string };
        expect(statSync(saved).mode & 0o777).toBe(0o600);
        expect(statSync(join(configDirOf(env), "keys")).mode & 0o777).toBe(
            0o700
        );
        const { secret } = JSON.parse(readFileSync(saved, "utf8")) as {
            secret: string;
        };
        expect(io.out.join("")).not.toContain(secret);

        expect(await runCommand(["auth", "status"], { env })).toMatchObject({
            output: {
                address: (login.output as { address: string }).address,
                apiUrl: "https://dev-api.gum.ag/app/v1",
                profile: "bot",
                source: saved,
            },
        });
        expect(
            await runCommand(["auth", "login", "--profile", "bot", "--evm"], {
                env,
            })
        ).toMatchObject({
            exitCode: 1,
            output: { error: { code: "wallet_exists" } },
        });
        expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual({
            kind: "solana",
            secret,
        });
    });

    test("--import reads the key from stdin, or asks without echo on a terminal", async () => {
        const piped = tempEnv();
        const pipedIo = memoryIo({ stdin: `${EVM_KEY}\n` });
        expect(
            await runCommand(["auth", "login", "--import"], {
                env: piped,
                io: pipedIo,
            })
        ).toMatchObject({
            output: { address: evmWallet(EVM_KEY).address, kind: "evm" },
        });
        expect(pipedIo.out.join("") + pipedIo.err.join("")).not.toContain(
            EVM_KEY.slice(2)
        );

        const solana = newKey("solana");
        const asked: string[] = [];
        const terminal = memoryIo({
            secret: (question) => {
                asked.push(question);
                return Promise.resolve(solana.secret);
            },
            terminal: true,
        });
        expect(
            await runCommand(["auth", "login", "--import"], {
                env: tempEnv(),
                io: terminal,
            })
        ).toMatchObject({ output: { kind: "solana" } });
        expect(asked).toHaveLength(1);
        expect(terminal.out.join("")).not.toContain(solana.secret);

        expect(
            await runCommand(["auth", "login", "--import"], {
                env: tempEnv(),
                io: memoryIo({ stdin: "not a key" }),
            })
        ).toMatchObject({ output: { error: { code: "invalid_key" } } });
    });

    test("logout moves the key to keys/archive with unique names and 0600 permissions", async () => {
        const env = tempEnv();
        const login = await runCommand(["auth", "login"], { env });
        const { saved } = login.output as { saved: string };
        const logout = await runCommand(["auth", "logout"], { env });
        expect(logout.exitCode).toBe(0);
        expect(existsSync(saved)).toBe(false);
        const archive = join(configDirOf(env), "keys", "archive");
        expect(readdirSync(archive)).toHaveLength(1);
        const firstArchived = (logout.output as { archived: string[] })
            .archived[0] as string;
        expect(statSync(firstArchived).mode & 0o777).toBe(0o600);
        // Logging in and out again immediately never overwrites the previous archive.
        await runCommand(["auth", "login"], { env });
        await runCommand(["auth", "logout"], { env });
        expect(readdirSync(archive)).toHaveLength(2);
        expect(
            (await runCommand(["auth", "status"], { env })).output
        ).toMatchObject({ error: { code: "no_wallet" } });
        expect(
            (await runCommand(["auth", "logout"], { env })).output
        ).toMatchObject({ error: { code: "no_wallet" } });
    });

    test("auth use switches the default profile", async () => {
        const env = tempEnv();
        await runCommand(["auth", "login", "--profile", "one"], { env });
        await runCommand(["auth", "login", "--profile", "two"], { env });
        expect(resolveSettings(env).profile).toBe("two");
        expect(await runCommand(["auth", "use", "one"], { env })).toMatchObject(
            {
                output: { profile: "one" },
            }
        );
        expect(resolveSettings(env).profile).toBe("one");
        expect(
            (await runCommand(["auth", "use", "three"], { env })).output
        ).toMatchObject({ error: { code: "unknown_profile" } });
    });
});

describe("which key and API", () => {
    test("an environment key wins over the profile's, and the old wallet.json still counts", async () => {
        const env = tempEnv();
        const dir = configDirOf(env);
        mkdirSync(dir, { recursive: true });
        const legacy = newKey("solana");
        writeFileSync(join(dir, "wallet.json"), JSON.stringify(legacy));
        expect((await runCommand(["whoami"], { env })).output).toMatchObject({
            kind: "solana",
            source: join(dir, "wallet.json"),
        });
        expect(
            (
                await runCommand(["whoami"], {
                    env: { ...env, GUM_EVM_PRIVATE_KEY: EVM_KEY },
                })
            ).output
        ).toMatchObject({ kind: "evm", source: "GUM_EVM_PRIVATE_KEY" });
        expect(await runCommand(["auth", "login"], { env })).toMatchObject({
            output: { error: { code: "wallet_exists" } },
        });
    });

    test("--network, then GUM_API_URL, then the profile, then mainnet", async () => {
        const env = tempEnv();
        await runCommand(["auth", "login", "--network", "devnet"], { env });
        expect(resolveSettings(env)).toMatchObject({
            apiUrl: "https://dev-api.gum.ag/app/v1",
            network: "devnet",
        });
        expect(
            resolveSettings({ ...env, GUM_API_URL: "http://localhost:4000/v1" })
        ).toMatchObject({
            apiUrl: "http://localhost:4000/v1",
            network: "custom",
        });
        expect(
            resolveSettings(
                { ...env, GUM_API_URL: "http://localhost:4000/v1" },
                { network: "mainnet" }
            )
        ).toMatchObject({
            apiUrl: "https://api.gum.ag/app/v1",
            network: "mainnet",
        });
        expect(resolveSettings(tempEnv())).toMatchObject({
            network: "mainnet",
        });
        expect(() => resolveSettings(env, { network: "testnet" })).toThrow(
            "--network must be mainnet or devnet."
        );
    });

    test("the USD limit is the lowest one set", () => {
        expect(limitOf(undefined, {}, {})).toBeUndefined();
        expect(limitOf(100, { GUM_MAX_TRADE_USD: "5" }, {})).toBe(5);
        expect(
            limitOf(3, { GUM_MAX_TRADE_USD: "5" }, { profileMaxUsd: 4 })
        ).toBe(3);
        expect(
            limitOf(undefined, { GUM_MAX_TRADE_USD: "" }, { profileMaxUsd: 4 })
        ).toBe(4);
        expect(() =>
            limitOf(undefined, { GUM_MAX_TRADE_USD: "ten" }, {})
        ).toThrow("GUM_MAX_TRADE_USD must be a number of dollars.");
        expect(() => limitOf(-1, {}, {})).toThrow(
            "--max-usd must be a number of dollars."
        );
    });
});

describe("profile names and saved limits", () => {
    test("an upper-case name is refused, so it can't open a profile's key without its limit", async () => {
        const env = tempEnv();
        expect(
            await runCommand(
                ["auth", "login", "--profile", "bot", "--max-usd", "25"],
                { env, io: memoryIo() }
            )
        ).toMatchObject({ exitCode: 0, output: { maxTradeUsd: 25 } });
        for (const argv of [
            ["auth", "status", "--profile", "BOT"],
            ["auth", "login", "--profile", "Bot"],
            ["auth", "use", "BOT"],
        ]) {
            expect(
                await runCommand(argv, { env, io: memoryIo() })
            ).toMatchObject({
                exitCode: 1,
                output: { error: { code: "invalid_request" } },
            });
        }
        expect(readdirSync(join(configDirOf(env), "keys"))).toEqual([
            "bot.json",
        ]);
    });

    test("a name Object.prototype has is not a saved profile", async () => {
        expect(
            await runCommand(["auth", "use", "constructor"], {
                env: tempEnv(),
                io: memoryIo(),
            })
        ).toMatchObject({
            exitCode: 1,
            output: { error: { code: "unknown_profile" } },
        });
    });

    test.each(["25", null, -1, {}])(
        "a saved limit that isn't a number of dollars stops the run: %p",
        async (saved) => {
            const env = tempEnv();
            const dir = configDirOf(env);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                join(dir, "config.json"),
                JSON.stringify({
                    profile: "bot",
                    profiles: { bot: { maxTradeUsd: saved } },
                })
            );
            expect(
                await runCommand(["auth", "status"], { env, io: memoryIo() })
            ).toMatchObject({
                exitCode: 1,
                output: { error: { code: "invalid_config" } },
            });
        }
    );

    test.each([
        "null",
        "[]",
        '"broken"',
        JSON.stringify({ profiles: null }),
        JSON.stringify({ profiles: [] }),
        JSON.stringify({ profile: 42, profiles: {} }),
        JSON.stringify({ profile: "bot", profiles: { bot: null } }),
        JSON.stringify({ profile: "bot", profiles: { bot: [] } }),
        JSON.stringify({
            profile: "bot",
            profiles: { bot: { apiUrl: "http://api.gum.ag/app/v1" } },
        }),
        JSON.stringify({
            profile: "bot",
            profiles: { bot: { network: "testnet" } },
        }),
    ])("malformed config.json fails closed: %s", async (rawConfig) => {
        const env = tempEnv();
        const dir = configDirOf(env);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "config.json"), rawConfig);
        expect(
            await runCommand(["auth", "status"], { env, io: memoryIo() })
        ).toMatchObject({
            exitCode: 1,
            output: { error: { code: "invalid_config" } },
        });
    });

    test("keyPathOf rejects path traversal and GUM_API_URL rejects plaintext non-loopback hosts", () => {
        expect(() => keyPathOf("/tmp/gum", "../evil")).toThrow("profile name");
        expect(() =>
            resolveSettings(
                tempEnv({ GUM_API_URL: "http://api.gum.ag/app/v1" })
            )
        ).toThrow("https://");
    });
});
