import { GumError } from "./api";
import type { Context } from "./context";
import { requireWallet } from "./profile";
import { runGenerated } from "./run";
import { limitFor } from "./run/signed";
import { type Options, requestOf } from "./run/values";
import { operationById, TRADING_API } from "./tree";

type PerpsPositionRecord = {
    avgEntryPrice?: string;
    fundingAccrued?: string;
    isolated?: boolean;
    liquidationPrice?: string | null;
    margin?: string;
    markPrice?: string;
    selectedLeverage?: number | null;
    side?: string;
    size?: string;
    symbol?: string;
    unrealizedPnl?: string;
    unrealizedPnlPercent?: string;
};

type PerpsOpenOrderRecord = {
    clientOrderId?: string | null;
    initialSize?: string;
    isolated?: boolean;
    orderId?: string;
    price?: string;
    reduceOnly?: boolean;
    remainingSize?: string;
    side?: string;
    status?: string;
    symbol?: string;
};

type PerpsSubaccountRecord = {
    isolated?: boolean;
    market?: string | null;
    openOrders?: PerpsOpenOrderRecord[];
    positions?: PerpsPositionRecord[];
    pubkey?: string;
    subaccountId?: number;
};

type PerpsAccountResponse = {
    account?: string;
    address?: string;
    exists?: boolean;
    subaccounts?: PerpsSubaccountRecord[];
};

type EnrichedPosition = PerpsPositionRecord & {
    marginMode: "cross" | "isolated";
    side: "long" | "short";
    size: string;
    subaccountId: number;
    symbol: string;
    tradingAccount: string;
};

type EnrichedOpenOrder = PerpsOpenOrderRecord & {
    isolated: boolean;
    marginMode: "cross" | "isolated";
    subaccountId: number;
    symbol: string;
    tradingAccount: string;
};

const PERP_SUFFIX = /-PERP$/i;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

const normalizeSymbol = (value: string) =>
    value.trim().toUpperCase().replace(PERP_SUFFIX, "");

type ScaledDecimal = { scale: number; unscaled: bigint };

const parseDecimal = (raw: string): ScaledDecimal | null => {
    const trimmed = raw.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
        return null;
    }
    const dot = trimmed.indexOf(".");
    const scale = dot >= 0 ? trimmed.length - dot - 1 : 0;
    const unscaled = BigInt(dot >= 0 ? trimmed.replace(".", "") : trimmed);
    return { scale, unscaled };
};

const parsePositiveDecimal = (raw: string, label: string): ScaledDecimal => {
    const parsed = parseDecimal(raw);
    if (!parsed) {
        throw new GumError(
            "invalid_request",
            `${label} must be a positive decimal number.`
        );
    }
    if (parsed.unscaled <= 0n) {
        throw new GumError(
            "invalid_request",
            `${label} must be greater than 0.`
        );
    }
    return parsed;
};

const isPositiveDecimal = (raw: unknown): raw is string => {
    if (typeof raw !== "string") {
        return false;
    }
    const parsed = parseDecimal(raw);
    return parsed !== null && parsed.unscaled > 0n;
};

const compareDecimals = (left: ScaledDecimal, right: ScaledDecimal): number => {
    const maxScale = Math.max(left.scale, right.scale);
    const leftScaled = left.unscaled * 10n ** BigInt(maxScale - left.scale);
    const rightScaled = right.unscaled * 10n ** BigInt(maxScale - right.scale);
    if (leftScaled < rightScaled) {
        return -1;
    }
    return leftScaled > rightScaled ? 1 : 0;
};

const fetchPerpsAccount = async (
    context: Context,
    address: string,
    subaccountId?: number
): Promise<PerpsAccountResponse> => {
    const accountOp = operationById("getPerpsAccount");
    if (!accountOp) {
        throw new GumError(
            "internal_error",
            "The Trading API has no getPerpsAccount operation."
        );
    }
    const req = requestOf(accountOp, {
        address,
        ...(subaccountId === undefined ? {} : { subaccountId }),
    });
    const response = await context.api.get<PerpsAccountResponse>(
        req.path,
        req.query
    );
    if (
        typeof response !== "object" ||
        response === null ||
        !Array.isArray(response.subaccounts)
    ) {
        throw new GumError(
            "invalid_response",
            "The Perps account response was malformed."
        );
    }
    return response;
};

const subaccountFilter = (
    subaccount: PerpsSubaccountRecord,
    subaccountId?: number
) => subaccountId === undefined || subaccount.subaccountId === subaccountId;

const resolveReadAddress = (context: Context, rawAddress: unknown): string => {
    if (typeof rawAddress === "string" && rawAddress.trim().length > 0) {
        return rawAddress.trim();
    }
    return requireWallet(context.env, context.settings).address;
};

const normalizeOptionalSymbol = (rawSymbol: unknown): string | undefined => {
    if (typeof rawSymbol !== "string" || rawSymbol.trim().length === 0) {
        return undefined;
    }
    return normalizeSymbol(rawSymbol);
};

const collectPositions = (
    response: PerpsAccountResponse,
    filters: {
        marginMode?: "cross" | "isolated";
        subaccountId?: number;
        symbol?: string;
    }
): EnrichedPosition[] => {
    const matches: EnrichedPosition[] = [];
    for (const subaccount of response.subaccounts ?? []) {
        if (!subaccountFilter(subaccount, filters.subaccountId)) {
            continue;
        }
        const subaccountId = subaccount.subaccountId ?? 0;
        const tradingAccount = subaccount.pubkey ?? "";
        for (const position of subaccount.positions ?? []) {
            if (
                typeof position.symbol !== "string" ||
                !isPositiveDecimal(position.size)
            ) {
                continue;
            }
            if (position.side !== "long" && position.side !== "short") {
                throw new GumError(
                    "invalid_response",
                    `Unexpected position side "${String(position.side)}" for ${position.symbol}.`
                );
            }
            const normalized = normalizeSymbol(position.symbol);
            if (filters.symbol && normalized !== filters.symbol) {
                continue;
            }
            const isolated = Boolean(position.isolated ?? subaccount.isolated);
            const marginMode: "cross" | "isolated" = isolated
                ? "isolated"
                : "cross";
            if (filters.marginMode && marginMode !== filters.marginMode) {
                continue;
            }
            matches.push({
                ...position,
                isolated,
                marginMode,
                side: position.side,
                size: position.size.trim(),
                subaccountId,
                symbol: normalized,
                tradingAccount,
            });
        }
    }
    return matches;
};

/** Flat open positions view backed by GET /v1/perps/accounts/{address}. */
export const perpsPositions = async (context: Context, options: Options) => {
    const address = resolveReadAddress(context, options.address);
    const subaccountId =
        typeof options.subaccountId === "number"
            ? options.subaccountId
            : undefined;
    const symbol = normalizeOptionalSymbol(options.symbol);
    const response = await fetchPerpsAccount(context, address, subaccountId);
    const positions = collectPositions(response, { subaccountId, symbol });
    return {
        account: response.account ?? address,
        address: response.address ?? address,
        exists: response.exists ?? false,
        positions,
    };
};

/** Flat open orders view backed by GET /v1/perps/accounts/{address}. */
export const perpsOpenOrders = async (context: Context, options: Options) => {
    const address = resolveReadAddress(context, options.address);
    const subaccountId =
        typeof options.subaccountId === "number"
            ? options.subaccountId
            : undefined;
    const symbol = normalizeOptionalSymbol(options.symbol);
    const response = await fetchPerpsAccount(context, address, subaccountId);
    const openOrders: EnrichedOpenOrder[] = [];
    for (const subaccount of response.subaccounts ?? []) {
        if (!subaccountFilter(subaccount, subaccountId)) {
            continue;
        }
        const subId = subaccount.subaccountId ?? 0;
        const tradingAccount = subaccount.pubkey ?? "";
        for (const order of subaccount.openOrders ?? []) {
            if (typeof order.symbol !== "string") {
                continue;
            }
            const normalized = normalizeSymbol(order.symbol);
            if (symbol && normalized !== symbol) {
                continue;
            }
            const isolated = Boolean(order.isolated ?? subaccount.isolated);
            openOrders.push({
                ...order,
                isolated,
                marginMode: isolated ? "isolated" : "cross",
                subaccountId: subId,
                symbol: normalized,
                tradingAccount,
            });
        }
    }
    return {
        account: response.account ?? address,
        address: response.address ?? address,
        exists: response.exists ?? false,
        openOrders,
    };
};

/** Close all or part of an open Perps position with a market reduce-only order. */
export const perpsClose = async (
    context: Context,
    options: Options,
    signedOverrides: { requireLimit?: boolean; yes?: boolean } = {}
) => {
    const rawSymbol = typeof options.symbol === "string" ? options.symbol : "";
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
        throw new GumError("invalid_request", "symbol is required.");
    }

    const requestedSizeRaw =
        typeof options.size === "string" && options.size.trim().length > 0
            ? options.size.trim()
            : undefined;
    const requestedSize = requestedSizeRaw
        ? parsePositiveDecimal(requestedSizeRaw, "size")
        : undefined;

    const marginMode =
        options.marginMode === "cross" || options.marginMode === "isolated"
            ? options.marginMode
            : undefined;
    const subaccountId =
        typeof options.subaccountId === "number"
            ? options.subaccountId
            : undefined;
    const slippageBps =
        typeof options.slippageBps === "number"
            ? options.slippageBps
            : undefined;

    const signedOptions = {
        dryRun: options.dryRun === true,
        ...(typeof options.maxUsd === "number"
            ? { maxUsd: options.maxUsd }
            : {}),
        requireLimit:
            signedOverrides.requireLimit ?? options.requireLimit === true,
    };
    // Enforce limits and wallet presence before making any account read.
    limitFor(context, signedOptions);
    const wallet = requireWallet(context.env, context.settings);

    const response = await fetchPerpsAccount(
        context,
        wallet.address,
        subaccountId
    );
    const rawMatches = collectPositions(response, {
        marginMode,
        subaccountId,
        symbol,
    });

    // Deduplicate identical rows if upstream mirrors the exact same position.
    const deduped = new Map<string, EnrichedPosition>();
    for (const position of rawMatches) {
        const key = `${position.subaccountId}:${position.symbol}:${position.marginMode}:${position.side}:${position.size}`;
        if (!deduped.has(key)) {
            deduped.set(key, position);
        }
    }
    const matches = [...deduped.values()];

    if (matches.length === 0) {
        const scope = [
            marginMode ? `${marginMode} margin` : undefined,
            subaccountId === undefined
                ? undefined
                : `sub-account ${subaccountId}`,
        ]
            .filter(Boolean)
            .join(", ");
        throw new GumError(
            "not_found",
            scope
                ? `No open ${symbol} Perps position found (${scope}).`
                : `No open ${symbol} Perps position found.`
        );
    }

    if (matches.length > 1) {
        throw new GumError(
            "ambiguous_position",
            `Found ${matches.length} open ${symbol} Perps positions. Specify --margin-mode and/or --subaccount-id to choose one.`,
            {
                details: {
                    positions: matches.map((entry) => ({
                        marginMode: entry.marginMode,
                        side: entry.side,
                        size: entry.size,
                        subaccountId: entry.subaccountId,
                        symbol: entry.symbol,
                    })),
                },
            }
        );
    }

    const target = matches[0] as EnrichedPosition;
    const openSize = parsePositiveDecimal(target.size, "position size");
    if (requestedSize && compareDecimals(requestedSize, openSize) > 0) {
        throw new GumError(
            "invalid_request",
            `Close size ${requestedSizeRaw} exceeds open ${target.symbol} position size ${target.size}.`
        );
    }

    const orderCommand = TRADING_API.commands.find(
        (command) =>
            command.operationId === "quotePerpsOrder" &&
            !command.shortcutOf &&
            command.run.kind === "signed"
    );
    if (!orderCommand) {
        throw new GumError(
            "internal_error",
            "Missing perps orders create command definition."
        );
    }

    return runGenerated(
        orderCommand,
        context,
        {
            marginMode: target.marginMode,
            orderType: "market",
            reduceOnly: true,
            side: target.side === "long" ? "sell" : "buy",
            size: requestedSizeRaw ?? target.size,
            sizeCurrency: "base",
            ...(slippageBps === undefined ? {} : { slippageBps }),
            subaccountId: target.subaccountId,
            symbol: target.symbol,
        },
        {
            ...signedOptions,
            yes: signedOverrides.yes ?? options.yes === true,
        }
    );
};
