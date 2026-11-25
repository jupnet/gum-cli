import { describe, expect, test } from "bun:test";
import { GumError } from "./api";
import { runCommand } from "./main";
import { EVM_KEY, fakeApi, SOL, SOLANA_ACCOUNT, tempEnv } from "./testing";
import { evmWallet } from "./wallet";

const WALLET = evmWallet(EVM_KEY).address;
const env = () => tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY });
const tokens = () => ({
    tokens: [{ address: SOL, chainId: 900, symbol: "SOL", verified: true }],
});

describe("requests", () => {
    test("an address argument defaults to your wallet, and takes another one positionally or by flag", async () => {
        const { api, calls } = fakeApi({
            [`GET /balances/${SOLANA_ACCOUNT}`]: () => ({ usd: "1" }),
            [`GET /balances/${WALLET}`]: () => ({ usd: "2" }),
        });
        expect(
            (await runCommand(["balance"], { api, env: env() })).output
        ).toEqual({
            usd: "2",
        });
        expect(
            (
                await runCommand(["balances", "get", SOLANA_ACCOUNT], {
                    api,
                    env: env(),
                })
            ).output
        ).toEqual({ usd: "1" });
        expect(
            (
                await runCommand(
                    ["balances", "get", "--address", SOLANA_ACCOUNT],
                    {
                        api,
                        env: env(),
                    }
                )
            ).output
        ).toEqual({ usd: "1" });
        expect(calls).toHaveLength(3);
        expect(
            (
                await runCommand(
                    [
                        "balances",
                        "get",
                        SOLANA_ACCOUNT,
                        "--address",
                        SOLANA_ACCOUNT,
                    ],
                    { api, env: env() }
                )
            ).output
        ).toMatchObject({
            error: { message: expect.stringContaining("given twice") },
        });
    });

    test("a symbol becomes its token address and fills the chain; quotes leave out the bytes to sign", async () => {
        const { api, calls } = fakeApi({
            "GET /tokens": tokens,
            "POST /swap/quote": () => ({
                message: "bWVzc2FnZQ==",
                pay: { amount: "25", symbol: "USD" },
                signer: { address: WALLET, signWith: "evm" },
                transaction: "dHg=",
                usdValue: "25",
            }),
        });
        const result = await runCommand(
            [
                "swaps",
                "quote",
                "--side",
                "buy",
                "--token",
                "sol",
                "--amount",
                "25",
            ],
            { api, env: env() }
        );
        expect(calls.at(-1)?.body).toEqual({
            address: WALLET,
            amount: "25",
            chainId: 900,
            side: "buy",
            token: SOL,
        });
        expect(result.output).toEqual({
            pay: { amount: "25", symbol: "USD" },
            signer: { address: WALLET, signWith: "evm" },
            usdValue: "25",
        });
    });

    test("missing and invalid inputs are named before any call", async () => {
        const { api, calls } = fakeApi({});
        expect(
            (
                await runCommand(["swaps", "quote", "--side", "buy"], {
                    api,
                    env: env(),
                })
            ).output
        ).toMatchObject({
            error: {
                message: expect.stringContaining(
                    "swaps quote needs --amount and --token. Usage:"
                ),
            },
        });
        expect(
            (
                await runCommand(
                    [
                        "swaps",
                        "quote",
                        "--side",
                        "hold",
                        "--token",
                        "SOL",
                        "--amount",
                        "1",
                    ],
                    { api, env: env() }
                )
            ).output
        ).toMatchObject({
            error: { message: '--side must be "buy" or "sell".' },
        });
        expect(
            (
                await runCommand(
                    ["tokens", "search", "sol", "--limit", "500"],
                    {
                        api,
                        env: env(),
                    }
                )
            ).output
        ).toMatchObject({ error: { message: "--limit must be at most 50." } });
        expect(
            (await runCommand(["swaps", "get"], { api, env: env() })).output
        ).toMatchObject({
            error: { message: expect.stringContaining("<id>") },
        });
        expect(calls).toHaveLength(0);
    });

    test("--wait returns once final", async () => {
        const { api } = fakeApi({
            "GET /swap/ID1": () => ({
                final: true,
                id: "ID1",
                status: "completed",
            }),
        });
        expect(
            (
                await runCommand(["swaps", "get", "ID1", "--wait"], {
                    api,
                    env: env(),
                })
            ).output
        ).toEqual({ final: true, id: "ID1", status: "completed" });
    });
});

describe("history --all", () => {
    test("follows nextCursor and prints one JSON line per item", async () => {
        const pages: Record<string, unknown> = {
            "": { items: [{ id: 1 }, { id: 2 }], nextCursor: "c2" },
            c2: { items: [{ id: 3 }], nextCursor: null },
        };
        const { api, calls } = fakeApi({
            [`GET /history/${WALLET}`]: (_, query) =>
                pages[String(query?.cursor ?? "")],
        });
        const result = await runCommand(
            ["history", "list", "--all", "--type", "swap"],
            { api, env: env() }
        );
        expect(result.lines).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        expect(result.output).toBeUndefined();
        expect(calls.map((call) => call.query)).toEqual([
            { type: "swap" },
            { cursor: "c2", type: "swap" },
        ]);
    });
});

describe("watch", () => {
    test("prints each message and stops at the final one", async () => {
        const { api } = fakeApi({
            "STREAM /swap/ID1/events": () => [
                { final: false, id: "ID1", step: "Executing" },
                { final: true, id: "ID1", status: "completed" },
                { final: true, id: "ID1", status: "never read" },
            ],
        });
        const result = await runCommand(["swaps", "watch", "ID1"], {
            api,
            env: env(),
        });
        expect(result.lines).toEqual([
            { final: false, id: "ID1", step: "Executing" },
            { final: true, id: "ID1", status: "completed" },
        ]);
    });

    test("polls the status when the stream can't be opened", async () => {
        const { api, calls } = fakeApi({
            "GET /withdraw/W1": () => ({
                final: true,
                id: "W1",
                status: "completed",
            }),
            "STREAM /withdraw/W1/events": () => {
                throw new GumError("upstream_unavailable", "down", {
                    status: 503,
                });
            },
        });
        const result = await runCommand(["withdrawals", "watch", "W1"], {
            api,
            env: env(),
        });
        expect(result.lines).toEqual([
            { final: true, id: "W1", status: "completed" },
        ]);
        expect(calls.map((call) => call.method)).toEqual(["STREAM", "GET"]);
    });

    test("a request the API refuses isn't retried by polling", async () => {
        const { api } = fakeApi({});
        expect(
            (await runCommand(["swaps", "watch", "nope"], { api, env: env() }))
                .output
        ).toMatchObject({ error: { code: "not_found" } });
    });
});

describe("perps signed recovery and validation", () => {
    const perpsOrderQuote = () => ({
        account: WALLET,
        clientOrderId: null,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        marginMode: "cross",
        message: Buffer.from("perps-order-msg").toString("base64"),
        orderType: "limit",
        price: "150",
        quantity: "1",
        reduceOnly: false,
        side: "buy",
        signer: { address: WALLET, signWith: "evm" },
        subaccountId: 0,
        symbol: "SOL",
        timeInForce: "GoodTilCanceled",
        tradingAccount: "ta",
        transaction: "envelope",
        usdValue: "150",
    });

    test("submission timeout directs Perps commands to `gumag perps account get` instead of spot history", async () => {
        const { api } = fakeApi({
            "POST /perps/orders": () => {
                throw new GumError("timeout", "Request timed out.");
            },
            "POST /perps/orders/quote": perpsOrderQuote,
        });
        const result = await runCommand(
            [
                "long",
                "SOL",
                "1",
                "--order-type",
                "limit",
                "--price",
                "150",
                "--yes",
            ],
            { api, env: env() }
        );
        expect(result.exitCode).toBe(1);
        expect(result.output).toMatchObject({
            error: {
                code: "timeout",
                details: { retrySubmission: false, submissionUnknown: true },
                message: expect.stringContaining("gumag perps account get"),
            },
        });
        expect(JSON.stringify(result.output)).not.toContain(
            "gumag history list"
        );
    });

    test("rejects empty, incomplete, or mismatched 2xx synchronous Perps responses as unknown submission outcomes", async () => {
        for (const badBody of [
            null,
            {},
            // Missing required `account`
            { final: false, status: "accepted", type: "perps_order" },
            // Wrong operation type & status (e.g. cancel response on order submit)
            {
                account: WALLET,
                final: true,
                status: "completed",
                type: "perps_cancel",
            },
            // Unexpected status for perps_order
            {
                account: WALLET,
                final: false,
                status: "completed",
                type: "perps_order",
            },
            // Unexpected final flag for perps_order
            {
                account: WALLET,
                final: true,
                status: "accepted",
                type: "perps_order",
            },
            // Mismatched account
            {
                account: "other-account",
                final: false,
                status: "accepted",
                type: "perps_order",
            },
        ]) {
            const { api } = fakeApi({
                "POST /perps/orders": () => badBody,
                "POST /perps/orders/quote": perpsOrderQuote,
            });
            const result = await runCommand(
                [
                    "long",
                    "SOL",
                    "1",
                    "--order-type",
                    "limit",
                    "--price",
                    "150",
                    "--yes",
                ],
                { api, env: env() }
            );
            expect(result.exitCode).toBe(1);
            expect(result.output).toMatchObject({
                error: {
                    code: "invalid_response",
                    details: {
                        retrySubmission: false,
                        submissionUnknown: true,
                    },
                    message: expect.stringContaining("gumag perps account get"),
                },
            });
        }
    });

    test("accepts a matching synchronous Perps submission response", async () => {
        const { api } = fakeApi({
            "POST /perps/orders": () => ({
                account: WALLET,
                clientOrderId: null,
                explorerUrl: null,
                final: false,
                status: "accepted",
                symbol: "SOL",
                transactionId: null,
                type: "perps_order",
            }),
            "POST /perps/orders/quote": perpsOrderQuote,
        });
        const result = await runCommand(
            [
                "long",
                "SOL",
                "1",
                "--order-type",
                "limit",
                "--price",
                "150",
                "--yes",
            ],
            { api, env: env() }
        );
        expect(result.exitCode).toBe(0);
        expect(result.output).toMatchObject({
            account: WALLET,
            final: false,
            status: "accepted",
            type: "perps_order",
        });
    });
});
