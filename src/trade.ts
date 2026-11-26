import { GumError } from "./api";
import type { Wallet } from "./wallet";

/** A swap or withdrawal as the API reports it (the Activity object). */
export type Activity = {
    final: boolean;
    id: string;
    status: string;
    [field: string]: unknown;
};

export type Signer = { address: string; signWith: "evm" | "solana" };

const POLL_MS = 2000;
const STRICT_BASE64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/** Polls until `until` is true, or returns the latest answer once time is up. */
export const waitUntil = async <T>(
    read: () => Promise<T>,
    until: string,
    timeoutMs: number,
    pause: (ms: number) => Promise<void> = sleep
): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    const done = (value: T) =>
        (value as Record<string, unknown> | null)?.[until] === true;
    let latest = await read();
    while (!done(latest) && Date.now() < deadline) {
        await pause(POLL_MS);
        latest = await read();
    }
    return latest;
};

export const messageBytes = (quote: { message: string }) => {
    const trimmed = quote.message.trim();
    if (trimmed.length === 0 || !STRICT_BASE64.test(trimmed)) {
        throw new GumError(
            "invalid_response",
            "The quote message isn't valid base64."
        );
    }
    return Uint8Array.from(Buffer.from(trimmed, "base64"));
};

export const checkSigner = (signer: Signer, wallet: Wallet) => {
    const candidate = signer as unknown;
    const record =
        typeof candidate === "object" && candidate !== null
            ? (candidate as { address?: unknown; signWith?: unknown })
            : null;
    const address = typeof record?.address === "string" ? record.address : "";
    const signWith = record?.signWith;
    if (
        address.trim() === "" ||
        signWith !== wallet.kind ||
        (wallet.kind === "solana" && address !== wallet.address)
    ) {
        throw new GumError(
            "signer_mismatch",
            `The quote must be signed by ${address || "another signer"} (${typeof signWith === "string" ? signWith : "unknown"}), not by this ${wallet.kind} wallet.`
        );
    }
};

/**
 * Refuses anything over the limit, and anything it can't check against one:
 * a quote without a valid non-negative USD value is never signed while a limit is set.
 */
export const checkLimit = (usd: unknown, maxUsd: number | undefined) => {
    if (maxUsd === undefined) {
        return;
    }
    if (!Number.isFinite(maxUsd) || maxUsd < 0) {
        throw new GumError(
            "invalid_request",
            "The USD limit must be a non-negative number."
        );
    }
    const amount =
        typeof usd === "string" || typeof usd === "number"
            ? Number(usd)
            : Number.NaN;
    if (
        (typeof usd !== "string" && typeof usd !== "number") ||
        String(usd).trim() === "" ||
        !Number.isFinite(amount)
    ) {
        throw new GumError(
            "over_limit",
            `The quote has no USD amount to check against the $${maxUsd} limit, so nothing was signed. (An API older than this CLI doesn't send usdValue.)`
        );
    }
    if (amount < 0) {
        throw new GumError(
            "over_limit",
            `The quote has a negative USD amount (${usd}) and cannot be checked against the $${maxUsd} limit, so nothing was signed.`
        );
    }
    if (amount > maxUsd) {
        throw new GumError(
            "over_limit",
            `This is $${usd}, over the $${maxUsd} limit (the lowest of --max-usd, GUM_MAX_TRADE_USD and the profile's).`
        );
    }
};
