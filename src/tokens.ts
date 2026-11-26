import bs58 from "bs58";
import { type Api, GumError } from "./api";
import { routeOf } from "./tree";

export type Token = {
    address: string;
    chainId: number;
    decimals?: number | null;
    name?: string;
    priceUsd?: string | null;
    riskLevel?: string | null;
    symbol: string;
    type?: string;
    verified?: boolean;
};

export const SOLANA_CHAIN_ID = 900;
export const SUI_CHAIN_ID = 101;

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A Sui coin type, package::module::Type: 0x2::sui::SUI.
const SUI_COIN_TYPE = /^0x[0-9a-fA-F]{1,64}::\w+::\w+$/;

const isSolanaAddress = (value: string) => {
    if (!SOLANA_ADDRESS.test(value)) {
        return false;
    }
    try {
        return bs58.decode(value).length === 32;
    } catch {
        return false;
    }
};

export const isAddress = (value: string) =>
    isSolanaAddress(value) ||
    EVM_ADDRESS.test(value) ||
    SUI_COIN_TYPE.test(value);

const brief = (token: Token) => ({
    address: token.address,
    chainId: token.chainId,
    name: token.name,
    symbol: token.symbol,
    verified: token.verified,
});

/**
 * What "SOL" or "NVDAx" means on GUM. An address passes through: a base58
 * one defaults to Solana and a Sui coin type to Sui; an EVM one needs a
 * chain. A symbol must match a single verified token; unverified or ambiguous
 * matches list the candidates so the caller can pass a chain or an address.
 */
export const resolveToken = async (
    api: Api,
    token: string,
    chainId?: number
): Promise<Token> => {
    const value = token.trim();
    if (isAddress(value)) {
        if (chainId !== undefined) {
            return { address: value, chainId, symbol: value };
        }
        if (isSolanaAddress(value)) {
            return { address: value, chainId: SOLANA_CHAIN_ID, symbol: value };
        }
        if (SUI_COIN_TYPE.test(value)) {
            return { address: value, chainId: SUI_CHAIN_ID, symbol: value };
        }
        throw new GumError(
            "chain_required",
            "An EVM token address needs its chain, e.g. --chain 8453 for Base."
        );
    }

    const { tokens } = await api.get<{ tokens: Token[] }>(
        routeOf("searchTokens"),
        {
            chainId,
            limit: 25,
            query: value,
        }
    );
    const wanted = value.toLowerCase();
    const exact = tokens.filter(
        (candidate) =>
            candidate.symbol.toLowerCase() === wanted &&
            (chainId === undefined || candidate.chainId === chainId)
    );
    // Only auto-select a lone verified token by symbol, since unverified or
    // ambiguous tokens can spoof a ticker and spend real money.
    const verified = exact.filter((candidate) => candidate.verified === true);
    if (verified.length === 1 && verified[0]) {
        return verified[0];
    }
    if (exact.length === 0) {
        throw new GumError(
            "token_not_found",
            `No tradable token has the symbol ${value}${chainId === undefined ? "" : ` on chain ${chainId}`}. Pass its address, or look it up with \`gumag tokens search ${value}\`.`,
            { details: { candidates: tokens.slice(0, 5).map(brief) } }
        );
    }
    if (verified.length === 0) {
        throw new GumError(
            "unverified_token",
            `${value} only matched unverified token(s). Pass the token's address explicitly if you intend to trade it.`,
            { details: { candidates: exact.map(brief) } }
        );
    }
    throw new GumError(
        "ambiguous_token",
        `${exact.length} tokens use the symbol ${value}. Pass --chain or the token's address.`,
        { details: { candidates: exact.map(brief) } }
    );
};
