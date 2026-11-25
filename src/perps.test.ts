import { describe, expect, test } from "bun:test";
import { runCommand } from "./main";
import { EVM_KEY, fakeApi, tempEnv } from "./testing";

const EVM_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ACCOUNT_ROUTE = `GET /perps/accounts/${EVM_ACCOUNT}`;

const ACCOUNT_WITH_POSITIONS = {
    account: "gum-account",
    address: "gum-account",
    exists: true,
    subaccounts: [
        {
            accountValueUsd: "1000",
            availableToTradeUsd: "800",
            conditionalOrdersCount: 0,
            freeBalanceUsd: "800",
            isolated: false,
            leverages: [{ leverage: 5, marginMode: "cross", symbol: "SOL" }],
            maintenanceMarginUsd: "20",
            market: null,
            name: "Main",
            openOrders: [
                {
                    clientOrderId: "11",
                    initialSize: "1",
                    isolated: false,
                    orderId: "ord-1",
                    price: "140",
                    reduceOnly: false,
                    remainingSize: "1",
                    side: "buy",
                    status: "open",
                    symbol: "SOL",
                },
            ],
            positions: [
                {
                    avgEntryPrice: "150",
                    fundingAccrued: "0",
                    isolated: false,
                    liquidationPrice: "110",
                    margin: "60",
                    markPrice: "152",
                    selectedLeverage: 5,
                    side: "long",
                    size: "2",
                    symbol: "SOL",
                    unrealizedPnl: "4",
                    unrealizedPnlPercent: "6.67",
                },
                {
                    avgEntryPrice: "3000",
                    fundingAccrued: "0",
                    isolated: false,
                    liquidationPrice: "3500",
                    margin: "300",
                    markPrice: "2950",
                    selectedLeverage: 5,
                    side: "short",
                    size: "0.5",
                    symbol: "ETH",
                    unrealizedPnl: "25",
                    unrealizedPnlPercent: "8.33",
                },
            ],
            pubkey: "ta-main",
            subaccountId: 0,
        },
        {
            accountValueUsd: "200",
            availableToTradeUsd: "150",
            conditionalOrdersCount: 0,
            freeBalanceUsd: "150",
            isolated: true,
            leverages: [
                { leverage: 10, marginMode: "isolated", symbol: "BTC" },
            ],
            maintenanceMarginUsd: "10",
            market: "BTC",
            name: "BTC Isolated",
            openOrders: [
                {
                    clientOrderId: "22",
                    initialSize: "0.01",
                    isolated: true,
                    orderId: "ord-2",
                    price: "90000",
                    reduceOnly: false,
                    remainingSize: "0.01",
                    side: "buy",
                    status: "open",
                    symbol: "BTC",
                },
            ],
            positions: [
                {
                    avgEntryPrice: "95000",
                    fundingAccrued: "0",
                    isolated: true,
                    liquidationPrice: "86000",
                    margin: "95",
                    markPrice: "96000",
                    selectedLeverage: 10,
                    side: "long",
                    size: "0.01",
                    symbol: "BTC",
                    unrealizedPnl: "10",
                    unrealizedPnlPercent: "10.5",
                },
            ],
            pubkey: "ta-btc-iso",
            subaccountId: 0,
        },
    ],
};

const orderQuote = (overrides: Record<string, unknown> = {}) => ({
    account: "gum-account",
    clientOrderId: null,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    marginMode: "cross",
    message: Buffer.from("perps-order-msg").toString("base64"),
    orderType: "market",
    price: "152",
    quantity: "2",
    reduceOnly: true,
    side: "sell",
    signer: { address: "gum-account", signWith: "evm" },
    subaccountId: 0,
    symbol: "SOL",
    timeInForce: "ImmediateOrCancel",
    tradingAccount: "ta-main",
    transaction: "encoded-order-envelope",
    usdValue: "304",
    ...overrides,
});

describe("perps ergonomic commands", () => {
    const env = () => tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY });

    test("perps positions and perps orders list flatten and filter account state", async () => {
        const { api } = fakeApi({
            [ACCOUNT_ROUTE]: () => ACCOUNT_WITH_POSITIONS,
        });

        const allPositions = await runCommand(["perps", "positions"], {
            api,
            env: env(),
        });
        expect(allPositions.exitCode).toBe(0);
        expect(allPositions.output).toMatchObject({
            account: "gum-account",
            exists: true,
            positions: [
                { marginMode: "cross", side: "long", size: "2", symbol: "SOL" },
                {
                    marginMode: "cross",
                    side: "short",
                    size: "0.5",
                    symbol: "ETH",
                },
                {
                    marginMode: "isolated",
                    side: "long",
                    size: "0.01",
                    symbol: "BTC",
                    tradingAccount: "ta-btc-iso",
                },
            ],
        });

        const filteredPositions = await runCommand(
            ["perps", "positions", "--symbol", "sol-perp"],
            { api, env: env() }
        );
        expect(filteredPositions.exitCode).toBe(0);
        expect(
            (filteredPositions.output as { positions: unknown[] }).positions
        ).toHaveLength(1);

        const openOrders = await runCommand(
            ["perps", "orders", "list", "--symbol", "BTC"],
            { api, env: env() }
        );
        expect(openOrders.exitCode).toBe(0);
        expect(openOrders.output).toMatchObject({
            openOrders: [
                {
                    marginMode: "isolated",
                    orderId: "ord-2",
                    symbol: "BTC",
                    tradingAccount: "ta-btc-iso",
                },
            ],
        });
    });

    test("perps close closes full longs, partial shorts, respects confirmation, and rejects oversized or missing positions", async () => {
        const quoteBodies: Record<string, unknown>[] = [];
        const { api, calls } = fakeApi({
            [ACCOUNT_ROUTE]: () => ACCOUNT_WITH_POSITIONS,
            "POST /perps/orders": (body) => {
                const payload = body as { dryRun?: boolean };
                return payload.dryRun
                    ? {
                          account: "gum-account",
                          dryRun: true,
                          id: null,
                          type: "perps_order",
                          valid: true,
                      }
                    : {
                          account: "gum-account",
                          clientOrderId: null,
                          explorerUrl: null,
                          final: false,
                          status: "accepted",
                          symbol: "SOL",
                          transactionId: null,
                          type: "perps_order",
                      };
            },
            "POST /perps/orders/quote": (body) => {
                quoteBodies.push(body as Record<string, unknown>);
                return orderQuote({
                    marginMode: (body as Record<string, unknown>).marginMode,
                    side: (body as Record<string, unknown>).side,
                    symbol: (body as Record<string, unknown>).symbol,
                });
            },
        });

        // Without --yes on non-TTY, stops with confirmation_required and the quote.
        const needsConfirm = await runCommand(["perps", "close", "SOL"], {
            api,
            env: env(),
        });
        expect(needsConfirm.exitCode).toBe(1);
        expect(needsConfirm.output).toMatchObject({
            error: { code: "confirmation_required" },
        });
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

        // Partial close on an open short sends side: "buy" and base size.
        const partialShort = await runCommand(
            ["perps", "close", "ETH", "0.25", "--slippage", "150", "--yes"],
            { api, env: env() }
        );
        expect(partialShort.exitCode).toBe(0);
        expect(quoteBodies[1]).toMatchObject({
            marginMode: "cross",
            orderType: "market",
            reduceOnly: true,
            side: "buy",
            size: "0.25",
            sizeCurrency: "base",
            slippageBps: 150,
            subaccountId: 0,
            symbol: "ETH",
        });

        // Dry run works end to end without submitting.
        const dryRun = await runCommand(
            ["perps", "close", "BTC", "--dry-run", "--yes"],
            { api, env: env() }
        );
        expect(dryRun.exitCode).toBe(0);
        expect(dryRun.output).toMatchObject({
            dryRun: true,
            type: "perps_order",
            valid: true,
        });
        expect(quoteBodies[2]).toMatchObject({
            marginMode: "isolated",
            reduceOnly: true,
            side: "sell",
            size: "0.01",
            symbol: "BTC",
        });

        // Rejects close size exceeding open position.
        const oversized = await runCommand(
            ["perps", "close", "SOL", "2.5", "--yes"],
            { api, env: env() }
        );
        expect(oversized.exitCode).toBe(1);
        expect(oversized.output).toMatchObject({
            error: { code: "invalid_request" },
        });

        // Rejects missing position cleanly.
        const missing = await runCommand(["perps", "close", "DOGE", "--yes"], {
            api,
            env: env(),
        });
        expect(missing.exitCode).toBe(1);
        expect(missing.output).toMatchObject({
            error: { code: "not_found" },
        });

        // Fails fast with no_wallet before making any HTTP call.
        const beforeCount = calls.length;
        const noWallet = await runCommand(["perps", "close", "SOL", "--yes"], {
            api,
            env: tempEnv(),
        });
        expect(noWallet.exitCode).toBe(1);
        expect(noWallet.output).toMatchObject({
            error: { code: "no_wallet" },
        });
        expect(calls).toHaveLength(beforeCount);
    });

    test("perps close requires disambiguation when multiple positions match the same symbol", async () => {
        const quoteBodies: Record<string, unknown>[] = [];
        const { api } = fakeApi({
            [ACCOUNT_ROUTE]: () => ({
                account: "gum-account",
                address: "gum-account",
                exists: true,
                subaccounts: [
                    {
                        isolated: false,
                        openOrders: [],
                        positions: [
                            {
                                isolated: false,
                                side: "long",
                                size: "1",
                                symbol: "SOL",
                            },
                        ],
                        pubkey: "ta-0",
                        subaccountId: 0,
                    },
                    {
                        isolated: true,
                        market: "SOL",
                        openOrders: [],
                        positions: [
                            {
                                isolated: true,
                                side: "short",
                                size: "2",
                                symbol: "SOL",
                            },
                        ],
                        pubkey: "ta-0-iso",
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
                return orderQuote();
            },
        });

        const ambiguous = await runCommand(["perps", "close", "SOL", "--yes"], {
            api,
            env: env(),
        });
        expect(ambiguous.exitCode).toBe(1);
        expect(ambiguous.output).toMatchObject({
            error: { code: "ambiguous_position" },
        });

        const resolved = await runCommand(
            ["perps", "close", "SOL", "--margin-mode", "isolated", "--yes"],
            { api, env: env() }
        );
        expect(resolved.exitCode).toBe(0);
        expect(quoteBodies[0]).toMatchObject({
            marginMode: "isolated",
            reduceOnly: true,
            side: "buy",
            size: "2",
            symbol: "SOL",
        });
    });

    test("long/short use USD notional and leverage set / deposit / withdraw / orders cancel accept positional arguments", async () => {
        const bodies: Record<string, unknown> = {};
        const message = Buffer.from("perps-msg").toString("base64");
        const { api } = fakeApi({
            "POST /perps/deposit": () => ({
                account: "gum-account",
                explorerUrl: "https://explorer.gum.ag/tx/1",
                final: true,
                status: "completed",
                transactionId: "tx-1",
                type: "perps_deposit",
            }),
            "POST /perps/deposit/quote": (body) => {
                bodies.deposit = body;
                return {
                    account: "gum-account",
                    amount: "100",
                    expiresAt: new Date(Date.now() + 30_000).toISOString(),
                    message,
                    signer: { address: "gum-account", signWith: "evm" },
                    subaccountId: 0,
                    tradingAccount: "ta-main",
                    transaction: "tx-dep",
                    usdValue: "100",
                };
            },
            "POST /perps/leverage": () => ({
                account: "gum-account",
                explorerUrl: "https://explorer.gum.ag/tx/2",
                final: true,
                status: "completed",
                transactionId: "tx-2",
                type: "perps_leverage",
            }),
            "POST /perps/leverage/quote": (body) => {
                bodies.leverage = body;
                return {
                    account: "gum-account",
                    expiresAt: new Date(Date.now() + 30_000).toISOString(),
                    leverage: 5,
                    marginMode: "isolated",
                    message,
                    signer: { address: "gum-account", signWith: "evm" },
                    subaccountId: 0,
                    symbol: "SOL",
                    transaction: "tx-lev",
                    usdValue: "0",
                };
            },
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
            "POST /perps/orders/cancel": () => ({
                account: "gum-account",
                explorerUrl: null,
                final: false,
                status: "accepted",
                symbol: "SOL",
                transactionId: null,
                type: "perps_cancel",
            }),
            "POST /perps/orders/cancel/quote": (body) => {
                bodies.cancel = body;
                return {
                    account: "gum-account",
                    cancelAll: true,
                    clientOrderId: null,
                    expiresAt: new Date(Date.now() + 30_000).toISOString(),
                    marginMode: "cross",
                    message,
                    orderId: null,
                    signer: { address: "gum-account", signWith: "evm" },
                    subaccountId: 0,
                    symbol: "SOL",
                    tradingAccount: "ta-main",
                    transaction: "tx-cancel",
                    usdValue: "0",
                };
            },
            "POST /perps/orders/quote": (body) => {
                bodies.long = body;
                return orderQuote({ reduceOnly: false, side: "buy" });
            },
            "POST /perps/withdraw": () => ({
                account: "gum-account",
                explorerUrl: "https://explorer.gum.ag/tx/3",
                final: true,
                status: "completed",
                transactionId: "tx-3",
                type: "perps_withdraw",
            }),
            "POST /perps/withdraw/quote": (body) => {
                bodies.withdraw = body;
                return {
                    account: "gum-account",
                    amount: "50",
                    expiresAt: new Date(Date.now() + 30_000).toISOString(),
                    message,
                    signer: { address: "gum-account", signWith: "evm" },
                    subaccountId: 0,
                    tradingAccount: "ta-main",
                    transaction: "tx-wd",
                    usdValue: "50",
                };
            },
        });

        expect(
            (
                await runCommand(["long", "SOL", "100", "--yes"], {
                    api,
                    env: env(),
                })
            ).exitCode
        ).toBe(0);
        expect(bodies.long).toMatchObject({
            side: "buy",
            size: "100",
            sizeCurrency: "USD",
            symbol: "SOL",
        });

        expect(
            (
                await runCommand(
                    [
                        "perps",
                        "leverage",
                        "set",
                        "SOL",
                        "5",
                        "--margin-mode",
                        "isolated",
                        "--yes",
                    ],
                    { api, env: env() }
                )
            ).exitCode
        ).toBe(0);
        expect(bodies.leverage).toMatchObject({
            leverage: 5,
            marginMode: "isolated",
            symbol: "SOL",
        });

        expect(
            (
                await runCommand(["perps", "deposit", "100", "--yes"], {
                    api,
                    env: env(),
                })
            ).exitCode
        ).toBe(0);
        expect(bodies.deposit).toMatchObject({ amount: "100" });

        expect(
            (
                await runCommand(["perps", "withdraw", "50", "--yes"], {
                    api,
                    env: env(),
                })
            ).exitCode
        ).toBe(0);
        expect(bodies.withdraw).toMatchObject({ amount: "50" });

        expect(
            (
                await runCommand(
                    [
                        "perps",
                        "orders",
                        "cancel",
                        "SOL",
                        "--cancel-all",
                        "--yes",
                    ],
                    { api, env: env() }
                )
            ).exitCode
        ).toBe(0);
        expect(bodies.cancel).toMatchObject({ cancelAll: true, symbol: "SOL" });
    });
});
