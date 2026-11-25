import { defineAnnotations } from "../../codegen/annotations";

// How the GUM Trading API (openapi.json) becomes gumag commands and MCP tools.
// `bun run generate` rebuilds src/generated/trading-api.json from the two;
// it fails on any operation without an entry here.

export default defineAnnotations({
    api: "trading-api",
    flags: { chainId: "chain", destination: "to", slippageBps: "slippage" },
    operations: {
        executePerpsCancel: {
            exclude:
                "Submits a signed Perps cancellation: only perps orders cancel signs one, after confirmation.",
        },
        executePerpsDeposit: {
            exclude:
                "Submits a signed Perps deposit: only perps deposit signs one, after the USD limit and confirmation.",
        },
        executePerpsLeverage: {
            exclude:
                "Submits a signed Perps leverage update: only perps leverage set signs one, after confirmation.",
        },
        executePerpsOrder: {
            exclude:
                "Submits a signed Perps order: only perps orders create, perps close, long and short sign one, after the USD limit and confirmation.",
        },
        executePerpsWithdraw: {
            exclude:
                "Submits a signed Perps withdrawal: only perps withdraw signs one, after the USD limit and confirmation.",
        },
        executeSwap: {
            exclude:
                "Submits a signed quote: only swaps create, buy and sell sign one, after the USD limit and confirmation.",
        },
        executeWithdrawal: {
            exclude:
                "Submits a signed withdrawal: only withdrawals create and withdraw sign one, after the USD limit and confirmation.",
        },
        getBalances: {
            commands: [
                {
                    examples: [
                        "gumag balances get",
                        "gumag balances get 7jqXWdiyYkY9XUStYhbGzSgn1VCr9tMF4LNCK52oG76U",
                    ],
                    keywords: [
                        "holdings portfolio funds positions cash usd how much",
                    ],
                    mcp: {
                        description:
                            "USD cash and token holdings. Defaults to this server's wallet.",
                        tool: "get_balances",
                    },
                    path: ["balances", "get"],
                    shortcuts: [
                        {
                            args: ["address"],
                            keywords: [
                                "holdings portfolio funds cash usd how much",
                            ],
                            name: "balance",
                            summary:
                                "USD and token balances, yours unless you pass an address.",
                        },
                    ],
                    summary:
                        "USD and token balances, yours unless you pass an address.",
                },
            ],
        },
        getDepositAddresses: {
            commands: [
                {
                    examples: ["gumag deposit-addresses get"],
                    keywords: ["fund top up receive deposit address send in"],
                    mcp: {
                        description:
                            "Where to send funds to top up the account: one deposit address per chain, with its dollar token and minimum.",
                        tool: "get_deposit_addresses",
                    },
                    path: ["deposit-addresses", "get"],
                    shortcuts: [
                        {
                            args: ["address"],
                            keywords: ["fund top up receive address send in"],
                            name: "deposit",
                            summary:
                                "Where to send funds: your deposit address on every chain.",
                        },
                    ],
                    summary:
                        "Where to send funds: your deposit address on every chain.",
                },
            ],
        },
        getHistory: {
            commands: [
                {
                    examples: [
                        "gumag history list --type swap --limit 10",
                        "gumag history list --all --type deposit",
                        "gumag history list --token SOL",
                    ],
                    keywords: [
                        "activity transactions past trades deposits withdrawals",
                    ],
                    mcp: {
                        description:
                            "Deposits, swaps and withdrawals, newest first. Pass nextCursor back as cursor for the next page.",
                        tool: "get_history",
                    },
                    params: {
                        token: {
                            description:
                                "Only one market: a symbol (SOL) or the token's address. Found on its chain unless you pass --chain.",
                            resolve: "token",
                        },
                    },
                    path: ["history", "list"],
                    run: {
                        cursor: "cursor",
                        items: "items",
                        kind: "paginate",
                        next: "nextCursor",
                    },
                    summary: "Deposits, swaps and withdrawals, newest first.",
                },
            ],
        },
        getPerpsAccount: {
            commands: [
                {
                    examples: [
                        "gumag perps account get",
                        "gumag perps account get --subaccount-id 0",
                    ],
                    keywords: [
                        "perps positions margin equity pnl open orders leverage subaccount",
                    ],
                    mcp: {
                        description:
                            "GUM Perps sub-accounts, balances, margin, configured market leverage, open positions and resting orders. Defaults to this server's wallet.",
                        tool: "get_perps_account",
                    },
                    path: ["perps", "account", "get"],
                    summary:
                        "Perps sub-accounts, balances, configured market leverage, open positions and open orders.",
                },
            ],
        },
        getPerpsFundingHistory: {
            commands: [
                {
                    examples: [
                        "gumag perps funding list SOL",
                        "gumag perps funding list SPCX --limit 168",
                    ],
                    keywords: [
                        "funding rate history apr arbitrage spread hourly perps",
                    ],
                    mcp: {
                        description:
                            "Historical hourly funding rates and average annualized rate for a GUM Perps market.",
                        tool: "get_perps_funding_history",
                    },
                    path: ["perps", "funding", "list"],
                    summary:
                        "Hourly funding rate history and average APR for a Perps market.",
                },
            ],
        },
        getPerpsOrderbook: {
            commands: [
                {
                    examples: [
                        "gumag perps orderbook get SOL",
                        "gumag perps orderbook get SPCX --depth 10",
                    ],
                    keywords: [
                        "orderbook bids asks depth liquidity spread perps",
                    ],
                    mcp: {
                        description:
                            "Current L2 orderbook bids and asks for a GUM Perps market.",
                        tool: "get_perps_orderbook",
                    },
                    path: ["perps", "orderbook", "get"],
                    summary: "L2 orderbook bids and asks for a Perps market.",
                },
            ],
        },
        getSwap: {
            commands: [
                {
                    examples: ["gumag swaps get <id> --wait"],
                    keywords: [
                        "status track progress result order check done finished trade went through",
                    ],
                    mcp: {
                        description:
                            "A swap's status by id. Done once final is true; while pending, step says what's happening.",
                        tool: "get_swap",
                    },
                    path: ["swaps", "get"],
                    run: {
                        kind: "request",
                        wait: { timeoutSeconds: 600, until: "final" },
                    },
                    summary: "A swap's status; --wait polls until it's final.",
                },
            ],
        },
        getWithdrawal: {
            commands: [
                {
                    examples: ["gumag withdrawals get <id> --wait"],
                    keywords: [
                        "status track progress result payout check done arrived",
                    ],
                    mcp: {
                        description:
                            "A withdrawal's status by id. Done once final is true.",
                        tool: "get_withdrawal",
                    },
                    path: ["withdrawals", "get"],
                    run: {
                        kind: "request",
                        wait: { timeoutSeconds: 1200, until: "final" },
                    },
                    summary:
                        "A withdrawal's status; --wait polls until it's final.",
                },
            ],
        },
        listChains: {
            commands: [
                {
                    examples: ["gumag chains list"],
                    keywords: ["networks supported dollar token usdc usdt"],
                    mcp: {
                        description:
                            "Supported chains, each with its dollar token and whether USD can be withdrawn to it (usdWithdrawable).",
                        tool: "list_chains",
                    },
                    path: ["chains", "list"],
                    summary: "Supported chains and their dollar tokens.",
                },
            ],
        },
        listPerpsMarkets: {
            commands: [
                {
                    examples: ["gumag perps markets list"],
                    keywords: [
                        "perps perpetuals funding rate markets oi leverage fees stocks pre-ipo",
                    ],
                    mcp: {
                        description:
                            "List active GUM Perps markets with mark/index prices, hourly and annualized funding rates, open interest, maker/taker fees and margin tiers.",
                        tool: "list_perps_markets",
                    },
                    path: ["perps", "markets", "list"],
                    summary:
                        "Active GUM Perps markets, funding rates, fees and margin tiers.",
                },
            ],
        },
        quotePerpsCancel: {
            commands: [
                {
                    examples: [
                        "gumag perps orders cancel SOL --order-id 12345 --yes",
                        "gumag perps orders cancel SOL --cancel-all --dry-run --yes",
                    ],
                    keywords: ["cancel order perps close resting"],
                    mcp: {
                        description:
                            "Cancel one open GUM Perps order (orderId or clientOrderId) or all open orders in a market (cancelAll: true). Set dryRun to check without cancelling.",
                        tool: "perps_cancel_order",
                    },
                    params: {
                        address: { hidden: true },
                        symbol: { position: 0 },
                    },
                    path: ["perps", "orders", "cancel"],
                    run: {
                        expect: {
                            final: false,
                            statuses: ["accepted"],
                            type: "perps_cancel",
                        },
                        kind: "signed",
                        recovery: "gumag perps account get",
                        submit: "executePerpsCancel",
                        usd: "usdValue",
                    },
                    summary:
                        "Cancel one Perps order or all resting orders in a market.",
                },
            ],
        },
        quotePerpsDeposit: {
            commands: [
                {
                    examples: [
                        "gumag perps deposit 100 --dry-run --yes",
                        "gumag perps deposit 100 --subaccount-id 0 --yes",
                    ],
                    keywords: [
                        "perps margin collateral transfer spot usd into",
                    ],
                    mcp: {
                        description:
                            "Move USD from GUM spot balance into a GUM Perps sub-account (free). Set dryRun to check without moving funds. Needs a USD limit.",
                        tool: "perps_deposit",
                    },
                    params: {
                        address: { hidden: true },
                        amount: { position: 0 },
                    },
                    path: ["perps", "deposit"],
                    run: {
                        expect: {
                            final: true,
                            statuses: ["completed"],
                            type: "perps_deposit",
                        },
                        kind: "signed",
                        recovery: "gumag perps account get",
                        submit: "executePerpsDeposit",
                        usd: "usdValue",
                    },
                    summary:
                        "Move USD from GUM spot balance into a Perps sub-account.",
                },
            ],
        },
        quotePerpsLeverage: {
            commands: [
                {
                    examples: [
                        "gumag perps leverage set SOL 5 --dry-run --yes",
                        "gumag perps leverage set SOL 5 --margin-mode isolated --yes",
                    ],
                    keywords: ["perps leverage margin multiplier set update"],
                    mcp: {
                        description:
                            "Set target leverage for a GUM Perps market (cross or isolated). Set dryRun to check without submitting.",
                        tool: "perps_set_leverage",
                    },
                    params: {
                        address: { hidden: true },
                        leverage: { position: 1 },
                        symbol: { position: 0 },
                    },
                    path: ["perps", "leverage", "set"],
                    run: {
                        expect: {
                            final: true,
                            statuses: ["completed"],
                            type: "perps_leverage",
                        },
                        kind: "signed",
                        recovery: "gumag perps account get",
                        submit: "executePerpsLeverage",
                        usd: "usdValue",
                    },
                    summary: "Set leverage for a GUM Perps market.",
                },
            ],
        },
        quotePerpsOrder: {
            commands: [
                {
                    examples: [
                        "gumag perps orders quote --symbol SOL --side buy --size 1 --order-type limit --price 150",
                    ],
                    keywords: ["perps preview price order margin quote"],
                    mcp: {
                        description:
                            "Preview a GUM Perps market, limit or post-only order without submitting. Returns quantity, price and estimated USD notional.",
                        omit: ["address"],
                        tool: "quote_perps_order",
                    },
                    path: ["perps", "orders", "quote"],
                    run: { kind: "request", readOnly: true },
                    summary: "Preview a GUM Perps order without submitting it.",
                },
                {
                    examples: [
                        "gumag perps orders create --symbol SOL --side buy --size 1 --order-type limit --price 150 --dry-run --yes",
                        "gumag perps orders create --symbol SPCX --side sell --size 100 --size-currency USD --yes",
                    ],
                    keywords: ["perps trade long short market limit postonly"],
                    mcp: {
                        description:
                            "Place a GUM Perps market, limit or postOnly order with this wallet. side is buy (long) or sell (short); size is in base units (or USD when sizeCurrency is USD). Set dryRun to verify without submitting. Needs a USD limit.",
                        tool: "perps_place_order",
                    },
                    params: { address: { hidden: true } },
                    path: ["perps", "orders", "create"],
                    run: {
                        expect: {
                            final: false,
                            statuses: ["accepted"],
                            type: "perps_order",
                        },
                        kind: "signed",
                        recovery: "gumag perps account get",
                        submit: "executePerpsOrder",
                        usd: "usdValue",
                    },
                    shortcuts: [
                        {
                            args: ["symbol", "size"],
                            examples: [
                                "gumag long SOL 100 --dry-run --yes",
                                "gumag long SOL 100 --order-type limit --price 150 --yes",
                            ],
                            fixed: { side: "buy", sizeCurrency: "USD" },
                            keywords: ["perps buy open long leverage usd"],
                            name: "long",
                            placeholders: { size: "usd" },
                            summary:
                                "Open or add to a GUM Perps long position sized in USD notional (market by default; use `perps orders create` for base-unit sizing).",
                        },
                        {
                            args: ["symbol", "size"],
                            examples: [
                                "gumag short SOL 100 --dry-run --yes",
                                "gumag short SOL 100 --order-type limit --price 160 --yes",
                            ],
                            fixed: { side: "sell", sizeCurrency: "USD" },
                            keywords: [
                                "perps sell open short hedge leverage usd",
                            ],
                            name: "short",
                            placeholders: { size: "usd" },
                            summary:
                                "Open or add to a GUM Perps short position sized in USD notional (market by default; use `perps orders create` for base-unit sizing).",
                        },
                    ],
                    summary:
                        "Place a GUM Perps order: quote, confirm, sign locally and submit.",
                },
            ],
        },
        quotePerpsWithdraw: {
            commands: [
                {
                    examples: [
                        "gumag perps withdraw 50 --dry-run --yes",
                        "gumag perps withdraw 50 --subaccount-id 0 --yes",
                    ],
                    keywords: ["perps collateral spot margin transfer back"],
                    mcp: {
                        description:
                            "Move free USD from a GUM Perps sub-account back to your GUM spot balance (free). Set dryRun to check without moving funds. Needs a USD limit.",
                        tool: "perps_withdraw",
                    },
                    params: {
                        address: { hidden: true },
                        amount: { position: 0 },
                    },
                    path: ["perps", "withdraw"],
                    run: {
                        expect: {
                            final: true,
                            statuses: ["completed"],
                            type: "perps_withdraw",
                        },
                        kind: "signed",
                        recovery: "gumag perps account get",
                        submit: "executePerpsWithdraw",
                        usd: "usdValue",
                    },
                    summary:
                        "Move free USD from a Perps sub-account back to GUM spot.",
                },
            ],
        },
        quoteSwap: {
            commands: [
                {
                    examples: [
                        "gumag swaps quote --side buy --token SOL --amount 25",
                        "gumag swaps quote --side sell --token SOL --amount 0.5",
                    ],
                    keywords: ["price estimate how much cost receive preview"],
                    mcp: {
                        description:
                            "Price a buy or a sell without trading. Buys take amount in USD; sells take it in tokens. Returns pay, receive (with its minimum), fee, usdValue and expiresAt.",
                        omit: ["address"],
                        tool: "quote",
                    },
                    params: {
                        address: {
                            description:
                                "The account to quote for. Defaults to your wallet.",
                        },
                        chainId: {
                            description:
                                "The token's chain, e.g. 900 Solana or 8453 Base. Found from the token when left out.",
                        },
                        token: {
                            description:
                                "A symbol (SOL) or the token's address. A symbol on several chains needs --chain.",
                            resolve: "token",
                        },
                    },
                    path: ["swaps", "quote"],
                    run: { kind: "request", readOnly: true },
                    summary:
                        "Price a buy (amount in USD) or a sell (amount in tokens) without trading.",
                },
                {
                    examples: [
                        "gumag swaps create --side sell --token SOL --amount 0.5 --dry-run",
                        "gumag swaps create --side buy --token SOL --amount 5 --max-usd 10 --yes",
                    ],
                    keywords: ["trade swap execute order"],
                    mcp: {
                        description:
                            "Buy or sell with this wallet's GUM balance: quotes, signs, submits and waits up to a minute. Buys spend amount USD; sells sell amount tokens. Set dryRun to check everything without trading. Refused unless the server runs with a USD limit (GUM_MAX_TRADE_USD or the profile's). If the result isn't final yet, call get_swap with its id.",
                        tool: "trade",
                        waitSeconds: 60,
                    },
                    params: {
                        address: { hidden: true },
                        chainId: {
                            description:
                                "The token's chain, e.g. 900 Solana or 8453 Base. Found from the token when left out.",
                        },
                        token: {
                            description:
                                "A symbol (SOL) or the token's address. A symbol on several chains needs --chain.",
                            resolve: "token",
                        },
                    },
                    path: ["swaps", "create"],
                    run: {
                        kind: "signed",
                        status: "getSwap",
                        submit: "executeSwap",
                        usd: "usdValue",
                        waitSeconds: 180,
                    },
                    shortcuts: [
                        {
                            args: ["token", "amount"],
                            examples: [
                                "gumag buy SOL 5",
                                "gumag buy SOL 5 --dry-run --yes",
                            ],
                            fixed: { side: "buy" },
                            keywords: [
                                "purchase trade swap spend long ape get acquire",
                            ],
                            name: "buy",
                            placeholders: { amount: "usd" },
                            summary:
                                "Spend USD on a token: quote, confirm, sign, submit and wait until it's final.",
                        },
                        {
                            args: ["token", "amount"],
                            examples: ["gumag sell SOL 0.25 --yes"],
                            fixed: { side: "sell" },
                            keywords: [
                                "trade swap exit close dump cash out take profit",
                            ],
                            name: "sell",
                            summary:
                                "Sell a token for USD: quote, confirm, sign, submit and wait until it's final.",
                        },
                    ],
                    summary:
                        "Buy or sell: quote, confirm, sign locally, submit and wait until it's final.",
                },
            ],
        },
        quoteWithdrawal: {
            commands: [
                {
                    examples: [
                        "gumag withdrawals quote --amount 50 --token USD --to 0x1111111111111111111111111111111111111111 --chain 8453",
                    ],
                    keywords: ["fee estimate preview payout cost"],
                    mcp: {
                        description:
                            "Price a withdrawal without sending it: amount, fee, usdValue and warnings about the destination.",
                        omit: ["address"],
                        tool: "quote_withdrawal",
                    },
                    params: {
                        address: {
                            description:
                                "The account to withdraw from. Defaults to your wallet.",
                        },
                        token: {
                            description:
                                '"USD" (paid out as the chain\'s dollar token), or the symbol or address of a token you hold on that chain.',
                            resolve: "token-or-usd",
                        },
                    },
                    path: ["withdrawals", "quote"],
                    run: { kind: "request", readOnly: true },
                    summary:
                        "Price a withdrawal to an address on another chain without sending it.",
                },
                {
                    examples: [
                        "gumag withdrawals create --amount 50 --token USD --to 0x1111111111111111111111111111111111111111 --chain 8453 --dry-run",
                    ],
                    keywords: [
                        "send transfer payout cash out off ramp move funds usdc usdt",
                    ],
                    mcp: {
                        description:
                            "Send funds to an address on another chain. token is \"USD\" (paid out as that chain's dollar token) or a token you hold. Returns once submitted; follow it with get_withdrawal. Set dryRun to check without sending. Refused unless the server runs with a USD limit (GUM_MAX_TRADE_USD or the profile's).",
                        tool: "withdraw",
                        waitSeconds: 0,
                    },
                    params: {
                        address: { hidden: true },
                        token: {
                            description:
                                '"USD" (paid out as the chain\'s dollar token), or the symbol or address of a token you hold on that chain.',
                            resolve: "token-or-usd",
                        },
                    },
                    path: ["withdrawals", "create"],
                    run: {
                        kind: "signed",
                        status: "getWithdrawal",
                        submit: "executeWithdrawal",
                        usd: "usdValue",
                        waitSeconds: 1200,
                    },
                    shortcuts: [
                        {
                            args: ["amount", "token"],
                            examples: [
                                "gumag withdraw 50 USD --to 0x1111111111111111111111111111111111111111 --chain 8453 --dry-run --yes",
                            ],
                            keywords: [
                                "send transfer payout cash out off ramp move funds usdc usdt",
                            ],
                            name: "withdraw",
                            placeholders: { token: "USD|token" },
                            summary:
                                "Send USD or a token to an address on another chain.",
                        },
                    ],
                    summary:
                        "Send USD or a token to an address on another chain: quote, confirm, sign, submit and wait until it's final.",
                },
            ],
        },
        searchTokens: {
            commands: [
                {
                    examples: [
                        "gumag tokens search sol",
                        "gumag tokens search usdc --chain 8453",
                    ],
                    keywords: ["find lookup symbol stock price address"],
                    mcp: {
                        description:
                            "Find tradable tokens and stocks by symbol, name or address. Returns address, chainId, decimals, priceUsd, verified and riskLevel.",
                        tool: "search_tokens",
                    },
                    params: { query: { position: 0, variadic: true } },
                    path: ["tokens", "search"],
                    summary:
                        "Find tradable tokens and stocks by symbol, name or address.",
                },
            ],
        },
        streamDeposits: {
            commands: [
                {
                    examples: ["gumag deposits watch --timeout 600"],
                    keywords: ["live arrive incoming credited wait"],
                    path: ["deposits", "watch"],
                    run: { kind: "stream" },
                    summary:
                        "Follow deposits as they arrive: one JSON line per update.",
                },
            ],
        },
        streamSwap: {
            commands: [
                {
                    examples: ["gumag swaps watch <id>"],
                    keywords: ["live follow progress"],
                    path: ["swaps", "watch"],
                    run: {
                        fallback: "getSwap",
                        kind: "stream",
                        until: "final",
                    },
                    summary:
                        "Follow a swap: one JSON line per update until it's final.",
                },
            ],
        },
        streamWithdrawal: {
            commands: [
                {
                    examples: ["gumag withdrawals watch <id>"],
                    keywords: ["live follow progress payout"],
                    path: ["withdrawals", "watch"],
                    run: {
                        fallback: "getWithdrawal",
                        kind: "stream",
                        until: "final",
                    },
                    summary:
                        "Follow a withdrawal: one JSON line per update until it's final.",
                },
            ],
        },
    },
    resolve: { address: "wallet" },
});
