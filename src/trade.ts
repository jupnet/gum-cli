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

export const messageBytes = (quote: { message: string }) =>
    Uint8Array.from(Buffer.from(quote.message, "base64"));

export const checkSigner = (signer: Signer, wallet: Wallet) => {
    if (
        signer.signWith !== wallet.kind ||
        (wallet.kind === "solana" && signer.address !== wallet.address)
    ) {
        throw new GumError(
            "signer_mismatch",
            `The quote must be signed by ${signer.address} (${signer.signWith}), not by this ${wallet.kind} wallet.`
        );
    }
};

/**
 * Refuses anything over the limit, and anything it can't check against one:
 * a quote without a USD value is never signed while a limit is set.
 */
export const checkLimit = (usd: unknown, maxUsd: number | undefined) => {
    if (maxUsd === undefined) {
        return;
    }
    if (
        (typeof usd !== "string" && typeof usd !== "number") ||
        String(usd).trim() === "" ||
        !Number.isFinite(Number(usd))
    ) {
        throw new GumError(
            "over_limit",
            `The quote has no USD amount to check against the $${maxUsd} limit, so nothing was signed. (An API older than this CLI doesn't send usdValue.)`
        );
    }
    if (Number(usd) > maxUsd) {
        throw new GumError(
            "over_limit",
            `This is $${usd}, over the $${maxUsd} limit (the lowest of --max-usd, GUM_MAX_TRADE_USD and the profile's).`
        );
    }
};
