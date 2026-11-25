import { describe, expect, test } from "bun:test";
import type { GumError } from "./api";
import { fakeApi, SOL } from "./testing";
import { resolveToken } from "./tokens";
import { checkLimit, waitUntil } from "./trade";

const tokens = [
    { address: SOL, chainId: 900, symbol: "SOL", verified: true },
    {
        address: "SoLBridged11111111111111111111111111111111",
        chainId: 56,
        symbol: "SOL",
        verified: false,
    },
    {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        chainId: 1,
        symbol: "USDC",
        verified: true,
    },
    {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        chainId: 8453,
        symbol: "USDC",
        verified: true,
    },
];

const errorOf = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        return error as GumError;
    }
    throw new Error("expected a GumError");
};

describe("resolveToken", () => {
    const { api } = fakeApi({ "GET /tokens": () => ({ tokens }) });

    test("a lone verified symbol wins; addresses pass through", async () => {
        expect((await resolveToken(api, "sol")).address).toBe(SOL);
        expect(await resolveToken(api, SOL)).toMatchObject({
            address: SOL,
            chainId: 900,
        });
        expect((await resolveToken(api, "USDC", 8453)).chainId).toBe(8453);
    });

    test("a Sui coin type is an address: Sui, unless a chain is given", async () => {
        const { api: offline, calls } = fakeApi({});
        const usdc =
            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
        expect(await resolveToken(offline, "0x2::sui::SUI", 101)).toMatchObject(
            {
                address: "0x2::sui::SUI",
                chainId: 101,
            }
        );
        expect(await resolveToken(offline, usdc)).toMatchObject({
            address: usdc,
            chainId: 101,
        });
        expect(calls).toHaveLength(0);
    });

    test("an ambiguous symbol or an EVM address without a chain asks for more", async () => {
        const ambiguous = await errorOf(resolveToken(api, "USDC"));
        expect(ambiguous.code).toBe("ambiguous_token");
        expect(ambiguous.details).toMatchObject({
            candidates: [{ chainId: 1 }, { chainId: 8453 }],
        });
        expect(
            (
                await errorOf(
                    resolveToken(
                        api,
                        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
                    )
                )
            ).code
        ).toBe("chain_required");
        expect((await errorOf(resolveToken(api, "NOPE"))).code).toBe(
            "token_not_found"
        );
    });
});

test("checkLimit refuses over the limit, and anything it can't check against one", () => {
    expect(() => checkLimit("5", undefined)).not.toThrow();
    expect(() => checkLimit(null, undefined)).not.toThrow();
    expect(() => checkLimit("1", 1)).not.toThrow();
    expect(() => checkLimit("1.5", 1)).toThrow("over the $1 limit");
    expect(() => checkLimit(null, 1)).toThrow("no USD amount");
    expect(() => checkLimit("", 1)).toThrow("no USD amount");
    expect(() => checkLimit("lots", 1)).toThrow("no USD amount");
});

test("waitUntil polls until the field is true, or returns the latest when time runs out", async () => {
    let reads = 0;
    const pauses: number[] = [];
    const done = await waitUntil(
        () => {
            reads += 1;
            return Promise.resolve({ final: reads >= 3 });
        },
        "final",
        60_000,
        (ms) => {
            pauses.push(ms);
            return Promise.resolve();
        }
    );
    expect(done).toEqual({ final: true });
    expect(pauses).toEqual([2000, 2000]);
    const latest = await waitUntil(
        () => Promise.resolve({ final: false, id: "x" }),
        "final",
        0,
        () => Promise.resolve()
    );
    expect(latest).toEqual({ final: false, id: "x" });
});
