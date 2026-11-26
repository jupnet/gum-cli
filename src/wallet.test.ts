import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import bs58 from "bs58";
import { recoverMessageAddress } from "viem";
import { evmWallet, importKey, newKey, solanaWallet, walletOf } from "./wallet";

const message = new TextEncoder().encode("quote message bytes");

const solanaSecret = () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { d, x } = privateKey.export({ format: "jwk" });
    return bs58.encode(
        Buffer.concat([
            Buffer.from(d ?? "", "base64url"),
            Buffer.from(x ?? "", "base64url"),
        ])
    );
};

const EVM_SIGNATURE = /^0x[0-9a-f]{130}$/;

// Well-known public Hardhat/Anvil default test Account #1 private key (never holds real funds).
const EVM_KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("solanaWallet", () => {
    test("signs the raw bytes with Ed25519, as base58, under its public key", async () => {
        const secret = solanaSecret();
        const wallet = solanaWallet(secret);
        const publicKey = bs58.decode(secret).subarray(32);
        expect(wallet.address).toBe(bs58.encode(publicKey));
        const signature = bs58.decode(await wallet.sign(message));
        expect(signature).toHaveLength(64);
        const key = createPublicKey({
            format: "jwk",
            key: {
                crv: "Ed25519",
                kty: "OKP",
                x: Buffer.from(publicKey).toString("base64url"),
            },
        });
        expect(verify(null, message, key, signature)).toBe(true);
    });

    test("rejects keys that aren't 64 matching bytes", () => {
        expect(() => solanaWallet("not-base58-0OIl")).toThrow("base58");
        expect(() => solanaWallet(bs58.encode(new Uint8Array(32)))).toThrow(
            "64 bytes"
        );
        const secret = bs58.decode(solanaSecret());
        secret[40] = (secret[40] ?? 0) ^ 1;
        expect(() => solanaWallet(bs58.encode(secret))).toThrow(
            "doesn't match"
        );
    });
});

describe("evmWallet", () => {
    test("signs with personal_sign over the raw bytes", async () => {
        const wallet = evmWallet(EVM_KEY);
        const signature = await wallet.sign(message);
        expect(signature).toMatch(EVM_SIGNATURE);
        expect(
            await recoverMessageAddress({
                message: { raw: message },
                signature: signature as `0x${string}`,
            })
        ).toBe(wallet.address as `0x${string}`);
    });

    test("takes the key with or without 0x, and rejects out-of-range secp256k1 keys", () => {
        expect(evmWallet(EVM_KEY.slice(2)).address).toBe(
            evmWallet(EVM_KEY).address
        );
        expect(evmWallet(`0X${EVM_KEY.slice(2)}`).address).toBe(
            evmWallet(EVM_KEY).address
        );
        expect(() => evmWallet("0x1234")).toThrow("32 bytes");
        for (const bad of [
            `0x${"0".repeat(64)}`,
            `0x${"f".repeat(64)}`,
            "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        ]) {
            expect(() => evmWallet(bad)).toThrow("secp256k1");
        }
    });
});

describe("keys", () => {
    test("new keys of either kind make working wallets", async () => {
        for (const kind of ["solana", "evm"] as const) {
            const wallet = walletOf(newKey(kind));
            expect(wallet.kind).toBe(kind);
            expect(await wallet.sign(message)).toBeString();
        }
        expect(() => walletOf(null as never)).toThrow("malformed");
        expect(() => walletOf({ kind: "btc" as never, secret: "abc" })).toThrow(
            "malformed"
        );
        expect(() => walletOf({ kind: "evm", secret: 123 as never })).toThrow(
            "malformed"
        );
    });

    test("an imported key is EVM when it's 32 bytes of hex, else a Solana secret", () => {
        expect(importKey(EVM_KEY.slice(2))).toEqual({
            kind: "evm",
            secret: EVM_KEY,
        });
        expect(importKey(`0X${EVM_KEY.slice(2)}`)).toEqual({
            kind: "evm",
            secret: EVM_KEY,
        });
        const solana = solanaSecret();
        expect(importKey(` ${solana}\n`)).toEqual({
            kind: "solana",
            secret: solana,
        });
        expect(() => importKey("")).toThrow("No key");
        expect(() => importKey("0x1234")).toThrow("base58");
    });
});
