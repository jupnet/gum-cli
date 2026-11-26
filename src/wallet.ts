import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign,
} from "node:crypto";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GumError } from "./api";

export type WalletKind = "evm" | "solana";

/** The account that signs: its address as the API takes it, and a signer. */
export type Wallet = {
    kind: WalletKind;
    /** Base58 for Solana, 0x for EVM: what the API takes as `address`. */
    address: string;
    /** Signs a quote's message bytes the way the API expects. */
    sign: (message: Uint8Array) => Promise<string>;
};

/** A key as profiles keep it on disk. */
export type StoredWallet = { kind: WalletKind; secret: string };

const EVM_PRIVATE_KEY = /^0[xX][0-9a-fA-F]{64}$/;
const HEX_KEY = /^(0[xX])?[0-9a-fA-F]{64}$/;
const SECP256K1_N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const normalizeHexKey = (raw: string) => {
    if (raw.startsWith("0x") || raw.startsWith("0X")) {
        return `0x${raw.slice(2)}`;
    }
    return `0x${raw}`;
};

/** A Solana wallet from its 64-byte secret key (seed, then public key) in base58. */
export const solanaWallet = (secret: string): Wallet => {
    let bytes: Uint8Array;
    try {
        bytes = bs58.decode(secret.trim());
    } catch (error) {
        throw new GumError(
            "invalid_key",
            "The Solana secret key must be base58.",
            { cause: error }
        );
    }
    if (bytes.length !== 64) {
        throw new GumError(
            "invalid_key",
            "The Solana secret key must be 64 bytes, seed then public key, in base58."
        );
    }
    let key: ReturnType<typeof createPrivateKey>;
    let x: string | undefined;
    try {
        key = createPrivateKey({
            format: "jwk",
            key: {
                crv: "Ed25519",
                d: Buffer.from(bytes.subarray(0, 32)).toString("base64url"),
                kty: "OKP",
                x: Buffer.from(bytes.subarray(32)).toString("base64url"),
            },
        });
        ({ x } = createPublicKey(key).export({ format: "jwk" }));
    } catch (error) {
        throw new GumError("invalid_key", "The Solana secret key is invalid.", {
            cause: error,
        });
    }
    const address = bs58.encode(Buffer.from(x ?? "", "base64url"));
    if (address !== bs58.encode(bytes.subarray(32))) {
        throw new GumError(
            "invalid_key",
            "The Solana secret key's public half doesn't match its seed."
        );
    }
    return {
        address,
        kind: "solana",
        sign: (message) =>
            Promise.resolve(bs58.encode(sign(null, message, key))),
    };
};

/** An EVM wallet from its 32-byte private key in hex. */
export const evmWallet = (privateKey: string): Wallet => {
    const trimmed = privateKey.trim();
    const hex = normalizeHexKey(trimmed);
    if (!EVM_PRIVATE_KEY.test(hex)) {
        throw new GumError(
            "invalid_key",
            "The EVM private key must be 32 bytes of hex."
        );
    }
    const scalar = BigInt(hex);
    if (scalar <= 0n || scalar >= SECP256K1_N) {
        throw new GumError(
            "invalid_key",
            "The EVM private key is outside the secp256k1 range."
        );
    }
    let account: ReturnType<typeof privateKeyToAccount>;
    try {
        account = privateKeyToAccount(hex as `0x${string}`);
    } catch (error) {
        throw new GumError("invalid_key", "The EVM private key is invalid.", {
            cause: error,
        });
    }
    return {
        address: account.address,
        kind: "evm",
        sign: (message) => account.signMessage({ message: { raw: message } }),
    };
};

/** The wallet a saved or imported key stands for. */
export const walletOf = (stored: StoredWallet) => {
    const candidate = stored as unknown;
    if (typeof candidate !== "object" || candidate === null) {
        throw new GumError(
            "invalid_key",
            "The stored wallet key is malformed."
        );
    }
    const { kind, secret } = candidate as { kind?: unknown; secret?: unknown };
    if (typeof secret !== "string" || (kind !== "evm" && kind !== "solana")) {
        throw new GumError(
            "invalid_key",
            "The stored wallet key is malformed."
        );
    }
    return kind === "evm" ? evmWallet(secret) : solanaWallet(secret);
};

/** A fresh key: Solana Ed25519 (64-byte secret in base58) or EVM secp256k1. */
export const newKey = (kind: WalletKind): StoredWallet => {
    if (kind === "evm") {
        return { kind, secret: generatePrivateKey() };
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    const { d, x } = privateKey.export({ format: "jwk" });
    if (!(d && x)) {
        throw new GumError("internal_error", "Couldn't create an Ed25519 key.");
    }
    return {
        kind,
        secret: bs58.encode(
            Buffer.concat([
                Buffer.from(d, "base64url"),
                Buffer.from(x, "base64url"),
            ])
        ),
    };
};

/** A pasted key: 32 bytes of hex is EVM; anything else must be a Solana secret. */
export const importKey = (raw: string): StoredWallet => {
    const secret = raw.trim();
    if (secret === "") {
        throw new GumError("invalid_key", "No key was given.");
    }
    const stored: StoredWallet = HEX_KEY.test(secret)
        ? {
              kind: "evm",
              secret: normalizeHexKey(secret),
          }
        : { kind: "solana", secret };
    walletOf(stored);
    return stored;
};
