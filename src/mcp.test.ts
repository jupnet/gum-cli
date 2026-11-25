import { describe, expect, test } from "bun:test";
import type { Context } from "./context";
import { memoryIo } from "./io";
import { createMcpHandler, respondToLine } from "./mcp";
import { resolveSettings } from "./profile";
import { EVM_KEY, fakeApi, tempEnv } from "./testing";

const GET_PERPS_ACCOUNT_PATH = /^GET \/perps\/accounts\//;
const EVM_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const contextFor = (
    api = fakeApi({}).api,
    env = tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY })
): Context => ({
    agent: "mcp",
    api,
    emit: () => undefined,
    env,
    interactive: false,
    io: memoryIo(),
    settings: resolveSettings(env),
});

type Listed = {
    result: {
        tools: {
            annotations: Record<string, boolean>;
            inputSchema: Record<string, unknown>;
            name: string;
        }[];
    };
};

type Called = { result: { content: { text: string }[]; isError?: boolean } };

describe("MCP handler", () => {
    const handle = createMcpHandler(contextFor(), "0.0.0");

    test("negotiates a protocol version", async () => {
        expect(
            await handle({
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-03-26" },
            })
        ).toMatchObject({
            result: {
                capabilities: { tools: {} },
                protocolVersion: "2025-03-26",
            },
        });
        expect(
            await handle({
                id: 2,
                method: "initialize",
                params: { protocolVersion: "1999-01-01" },
            })
        ).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    });

    test("lists the generated tools with plain JSON Schemas and honest hints", async () => {
        const listed = (await handle({
            id: 3,
            method: "tools/list",
        })) as Listed;
        const names = listed.result.tools.map((tool) => tool.name);
        expect(names).toEqual(
            expect.arrayContaining([
                "whoami",
                "list_chains",
                "search_tokens",
                "get_balances",
                "get_deposit_addresses",
                "get_history",
                "quote",
                "trade",
                "get_swap",
                "quote_withdrawal",
                "withdraw",
                "get_withdrawal",
                "list_perps_markets",
                "get_perps_orderbook",
                "get_perps_funding_history",
                "get_perps_account",
                "quote_perps_order",
                "perps_place_order",
                "perps_close_position",
                "perps_cancel_order",
                "perps_deposit",
                "perps_withdraw",
                "perps_set_leverage",
                "search_api",
                "call_api",
            ])
        );
        const perpsOrder = listed.result.tools.find(
            (tool) => tool.name === "perps_place_order"
        );
        expect(perpsOrder?.annotations).toEqual({
            destructiveHint: true,
            openWorldHint: true,
        });
        expect(
            listed.result.tools.find(
                (tool) => tool.name === "list_perps_markets"
            )?.annotations
        ).toEqual({ readOnlyHint: true });
        const trade = listed.result.tools.find((tool) => tool.name === "trade");
        expect(trade?.annotations).toEqual({
            destructiveHint: true,
            openWorldHint: true,
        });
        expect(trade?.inputSchema).toMatchObject({
            additionalProperties: false,
            properties: {
                dryRun: { type: "boolean" },
                side: { enum: ["buy", "sell"] },
            },
            required: ["amount", "side", "token"],
            type: "object",
        });
        expect(trade?.inputSchema).not.toHaveProperty("properties.address");
        expect(
            listed.result.tools.find((tool) => tool.name === "get_balances")
                ?.annotations
        ).toEqual({ readOnlyHint: true });
    });

    test("tool errors come back as isError results; protocol errors as JSON-RPC errors", async () => {
        expect(
            await handle({
                id: 4,
                method: "tools/call",
                params: { arguments: { side: "hold" }, name: "trade" },
            })
        ).toMatchObject({ result: { isError: true } });
        expect(
            await handle({
                id: 5,
                method: "tools/call",
                params: { name: "nope" },
            })
        ).toMatchObject({ error: { code: -32_602 } });
        expect(await handle({ id: 6, method: "resources/list" })).toMatchObject(
            {
                error: { code: -32_601 },
            }
        );
        expect(
            await handle({ method: "notifications/initialized" })
        ).toBeNull();
    });

    test("executes synchronous signed Perps tools without polling", async () => {
        const message = Buffer.from("perps-order-action").toString("base64");
        const { api, calls } = fakeApi({
            "POST /perps/orders": (body) => ({
                ...(body as Record<string, unknown>),
                account: "gum-account",
                explorerUrl: null,
                final: false,
                status: "accepted",
                symbol: "SOL",
                transactionId: null,
                type: "perps_order",
            }),
            "POST /perps/orders/quote": () => ({
                account: "gum-account",
                clientOrderId: null,
                expiresAt: new Date(Date.now() + 30_000).toISOString(),
                marginMode: "cross",
                message,
                orderType: "limit",
                price: "150",
                quantity: "1",
                reduceOnly: false,
                side: "buy",
                signer: { address: "gum-account", signWith: "evm" },
                subaccountId: 0,
                symbol: "SOL",
                timeInForce: "GoodTilCanceled",
                tradingAccount: "ta",
                transaction: "encoded-envelope",
                usdValue: "150",
            }),
        });
        const perpsHandle = createMcpHandler(
            contextFor(
                api,
                tempEnv({
                    GUM_EVM_PRIVATE_KEY: EVM_KEY,
                    GUM_MAX_TRADE_USD: "500",
                })
            ),
            "0.0.0"
        );
        const result = (await perpsHandle({
            id: 9,
            method: "tools/call",
            params: {
                arguments: {
                    orderType: "limit",
                    price: "150",
                    side: "buy",
                    size: "1",
                    symbol: "SOL",
                },
                name: "perps_place_order",
            },
        })) as Called;
        expect(result.result.isError).toBeUndefined();
        const payload = JSON.parse(result.result.content[0]?.text ?? "{}") as {
            final?: boolean;
            quote?: { symbol: string };
            status?: string;
            type?: string;
        };
        expect(payload.status).toBe("accepted");
        expect(payload.final).toBe(false);
        expect(payload.type).toBe("perps_order");
        expect(payload.quote?.symbol).toBe("SOL");
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            "POST /perps/orders/quote",
            "POST /perps/orders",
        ]);
    });

    test("perps_close_position closes an open position with a reduce-only market order and requires a USD limit", async () => {
        const message = Buffer.from("perps-close-action").toString("base64");
        const quoteBodies: Record<string, unknown>[] = [];
        const { api, calls } = fakeApi({
            [`GET /perps/accounts/${EVM_ACCOUNT}`]: () => ({
                account: "gum-account",
                address: "gum-account",
                exists: true,
                subaccounts: [
                    {
                        accountValueUsd: "1000",
                        availableToTradeUsd: "900",
                        conditionalOrdersCount: 0,
                        freeBalanceUsd: "900",
                        isolated: false,
                        leverages: [],
                        maintenanceMarginUsd: "20",
                        market: null,
                        name: "Main",
                        openOrders: [],
                        positions: [
                            {
                                avgEntryPrice: "150",
                                fundingAccrued: "0",
                                isolated: false,
                                liquidationPrice: "100",
                                margin: "50",
                                markPrice: "152",
                                selectedLeverage: 5,
                                side: "long",
                                size: "2",
                                symbol: "SOL",
                                unrealizedPnl: "4",
                                unrealizedPnlPercent: "8",
                            },
                        ],
                        pubkey: "ta-main",
                        subaccountId: 0,
                    },
                ],
            }),
            "POST /perps/orders": () => ({
                account: "gum-account",
                clientOrderId: null,
                explorerUrl: null,
                final: false,
                status: "accepted",
                symbol: "SOL",
                transactionId: null,
                type: "perps_order",
            }),
            "POST /perps/orders/quote": (body) => {
                quoteBodies.push(body as Record<string, unknown>);
                return {
                    account: "gum-account",
                    clientOrderId: null,
                    expiresAt: new Date(Date.now() + 30_000).toISOString(),
                    marginMode: "cross",
                    message,
                    orderType: "market",
                    price: "151",
                    quantity: "2",
                    reduceOnly: true,
                    side: "sell",
                    signer: { address: "gum-account", signWith: "evm" },
                    subaccountId: 0,
                    symbol: "SOL",
                    timeInForce: "ImmediateOrCancel",
                    tradingAccount: "ta-main",
                    transaction: "encoded-close-envelope",
                    usdValue: "302",
                };
            },
        });

        // Without a USD limit, refuses before any account read.
        const noLimitHandle = createMcpHandler(
            contextFor(api, tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY })),
            "0.0.0"
        );
        const refused = (await noLimitHandle({
            id: 10,
            method: "tools/call",
            params: {
                arguments: { symbol: "SOL" },
                name: "perps_close_position",
            },
        })) as Called;
        expect(refused.result.isError).toBe(true);
        expect(refused.result.content[0]?.text).toContain("limit_required");
        expect(calls).toHaveLength(0);

        const closeHandle = createMcpHandler(
            contextFor(
                api,
                tempEnv({
                    GUM_EVM_PRIVATE_KEY: EVM_KEY,
                    GUM_MAX_TRADE_USD: "500",
                })
            ),
            "0.0.0"
        );
        const closed = (await closeHandle({
            id: 11,
            method: "tools/call",
            params: {
                arguments: { symbol: "SOL" },
                name: "perps_close_position",
            },
        })) as Called;
        expect(closed.result.isError).toBeUndefined();
        expect(quoteBodies[0]).toMatchObject({
            marginMode: "cross",
            orderType: "market",
            reduceOnly: true,
            side: "sell",
            size: "2",
            sizeCurrency: "base",
            subaccountId: 0,
            symbol: "SOL",
        });
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            expect.stringMatching(GET_PERPS_ACCOUNT_PATH),
            "POST /perps/orders/quote",
            "POST /perps/orders",
        ]);
    });
});

describe("search_api and call_api", () => {
    const { api, calls } = fakeApi(
        {
            "GET /openapi.json": () => ({
                paths: {
                    "/prices/{address}": {
                        get: {
                            operationId: "getPriceHistory",
                            parameters: [
                                { in: "path", name: "address", required: true },
                                {
                                    in: "query",
                                    name: "days",
                                    schema: { type: "integer" },
                                },
                            ],
                            summary: "Price history of an account's holdings",
                        },
                    },
                },
            }),
            "GET /prices/addr": () => ({ points: [] }),
        },
        { undeclared: ["GET /prices/addr"] }
    );
    const handle = createMcpHandler(contextFor(api), "0.0.0");
    const call = (name: string, args: unknown) =>
        handle({
            id: 1,
            method: "tools/call",
            params: { arguments: args, name },
        }) as Promise<Called>;

    test("search_api finds an endpoint only the live API has; never a signed submit or a stream", async () => {
        const found = JSON.parse(
            (await call("search_api", { query: "price history" })).result
                .content[0]?.text ?? "{}"
        ) as { operations: { operationId: string }[] };
        expect(found.operations[0]?.operationId).toBe("getPriceHistory");
        const signed = (
            await call("search_api", { query: "submit signed buy" })
        ).result.content[0]?.text;
        expect(signed).not.toContain("executeSwap");
        expect(signed).not.toContain("streamSwap");
    });

    test("call_api calls it with typed parameters, and refuses signed submits", async () => {
        const priced = await call("call_api", {
            operationId: "getPriceHistory",
            params: { address: "addr", days: 7 },
        });
        expect(priced.result.isError).toBeUndefined();
        expect(calls.at(-1)).toMatchObject({
            path: "/prices/addr",
            query: { days: 7 },
        });
        const submit = await call("call_api", {
            body: {},
            operationId: "executeSwap",
        });
        expect(submit.result.isError).toBe(true);
        expect(submit.result.content[0]?.text).toContain("use_signed_command");
    });
});

describe("MCP over stdio", () => {
    const handle = createMcpHandler(contextFor(), "0");

    test.each([
        ["null", { error: { code: -32_600 } }],
        ["[null]", [{ error: { code: -32_600 } }]],
        ["[]", { error: { code: -32_600 } }],
        ["{}", { error: { code: -32_600 } }],
        ["[{}]", [{ error: { code: -32_600 } }]],
        ['{"id":1}', { error: { code: -32_600 } }],
        ['{"id":{},"method":"ping"}', { error: { code: -32_600 } }],
        ["{not json", { error: { code: -32_700 } }],
        ['{"jsonrpc":"2.0","id":7,"method":"ping"}', { id: 7, result: {} }],
    ])("%s", async (line, expected) => {
        expect(await respondToLine(handle, line)).toMatchObject(expected);
    });

    test.each([
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '[{"jsonrpc":"2.0","method":"notifications/initialized"}]',
    ])("%s gets no reply", async (line) => {
        expect(await respondToLine(handle, line)).toBeNull();
    });
});
