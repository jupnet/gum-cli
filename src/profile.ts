import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./agent";
import { GumError, NETWORKS, type Network } from "./api";
import { type StoredWallet, type Wallet, walletOf } from "./wallet";

// Profiles live in $XDG_CONFIG_HOME/gum (else ~/.config/gum):
//   config.json        { profile, profiles: { <name>: { network | apiUrl, maxTradeUsd } } }
//   keys/<name>.json   { kind, secret }, readable by you only
// GUM_SOLANA_SECRET_KEY / GUM_EVM_PRIVATE_KEY win over a profile's key, and
// the wallet.json older releases saved still counts as the default profile's.

export type Profile = {
    apiUrl?: string;
    maxTradeUsd?: number;
    network?: Network;
};

export type Config = { profile?: string; profiles: Record<string, Profile> };

export type Settings = {
    apiUrl: string;
    configDir: string;
    network: Network | "custom";
    profile: string;
    /** The profile's own USD limit, when it has one. */
    profileMaxUsd?: number;
};

// Lower case only: the key file is keys/<name>.json, and on a case-insensitive
// disk (macOS, Windows) "BOT" would open bot's key without bot's USD limit.
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const configDirOf = (env: Env) =>
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gum");

const configPathOf = (dir: string) => join(dir, "config.json");
export const keyPathOf = (dir: string, profile: string) =>
    join(dir, "keys", `${profile}.json`);
const legacyPathOf = (dir: string) => join(dir, "wallet.json");

const isNetwork = (value: unknown): value is Network =>
    typeof value === "string" && Object.hasOwn(NETWORKS, value);

/** No prototype, so a name like "constructor" is never taken for a saved profile. */
const profileMap = (profiles: unknown): Config["profiles"] =>
    Object.assign(
        Object.create(null) as Config["profiles"],
        typeof profiles === "object" && profiles !== null ? profiles : {}
    );

export const readConfig = (dir: string): Config => {
    const path = configPathOf(dir);
    if (!existsSync(path)) {
        return { profiles: profileMap({}) };
    }
    let parsed: { profile?: unknown; profiles?: unknown };
    try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
    } catch (error) {
        throw new GumError("invalid_config", `Couldn't read ${path}.`, {
            cause: error,
        });
    }
    return {
        ...(typeof parsed.profile === "string"
            ? { profile: parsed.profile }
            : {}),
        profiles: profileMap(parsed.profiles),
    };
};

export const writeConfig = (dir: string, config: Config) => {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    writeFileSync(configPathOf(dir), `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
    });
};

export const checkProfileName = (name: string) => {
    if (!PROFILE_NAME.test(name)) {
        throw new GumError(
            "invalid_request",
            "A profile name is lowercase letters, digits, - and _, up to 32 characters."
        );
    }
    return name;
};

/** --network, else GUM_API_URL, else the profile's API or network, else mainnet. */
const endpointOf = (
    env: Env,
    flag: string | undefined,
    entry: Profile
): { apiUrl: string; network: Settings["network"] } => {
    if (flag !== undefined) {
        if (!isNetwork(flag)) {
            throw new GumError(
                "invalid_request",
                "--network must be mainnet or devnet."
            );
        }
        return { apiUrl: NETWORKS[flag], network: flag };
    }
    const fromEnv = env.GUM_API_URL;
    if (fromEnv) {
        const known = (Object.keys(NETWORKS) as Network[]).find(
            (name) => NETWORKS[name] === fromEnv
        );
        return { apiUrl: fromEnv, network: known ?? "custom" };
    }
    if (entry.apiUrl) {
        return { apiUrl: entry.apiUrl, network: "custom" };
    }
    const network = isNetwork(entry.network) ? entry.network : "mainnet";
    return { apiUrl: NETWORKS[network], network };
};

/** The profile's saved USD limit. One that isn't a number of dollars stops the run instead of lifting the limit. */
const savedLimitOf = (
    entry: Profile,
    profile: string,
    dir: string
): number | undefined => {
    const value: unknown = entry.maxTradeUsd;
    if (value === undefined) {
        return;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
    }
    throw new GumError(
        "invalid_config",
        `Profile ${profile}'s maxTradeUsd in ${configPathOf(dir)} must be a number of dollars, like 25.`
    );
};

/**
 * Which profile, network and API this run uses: --profile, else GUM_PROFILE,
 * else the active profile; --network, else GUM_API_URL, else the profile's.
 */
export const resolveSettings = (
    env: Env,
    flags: { network?: string; profile?: string } = {}
): Settings => {
    const configDir = configDirOf(env);
    const config = readConfig(configDir);
    const profile = checkProfileName(
        flags.profile || env.GUM_PROFILE || config.profile || "default"
    );
    const entry = config.profiles[profile] ?? {};
    const { apiUrl, network } = endpointOf(env, flags.network, entry);
    const profileMaxUsd = savedLimitOf(entry, profile, configDir);
    return {
        apiUrl,
        configDir,
        network,
        profile,
        ...(profileMaxUsd === undefined ? {} : { profileMaxUsd }),
    };
};

const readKey = (path: string) => {
    try {
        return walletOf(JSON.parse(readFileSync(path, "utf8")) as StoredWallet);
    } catch (error) {
        if (error instanceof GumError) {
            throw error;
        }
        throw new GumError("invalid_key", `Couldn't read the key in ${path}.`, {
            cause: error,
        });
    }
};

/** The files that hold this profile's key, newest layout first. */
const keyFilesOf = (settings: Settings) => {
    const files = [keyPathOf(settings.configDir, settings.profile)];
    if (settings.profile === "default") {
        files.push(legacyPathOf(settings.configDir));
    }
    return files.filter((path) => existsSync(path));
};

export type LoadedWallet = { source: string; wallet: Wallet };

/** The wallet to sign with, and where its key came from; null when there is none. */
export const loadWallet = (
    env: Env,
    settings: Settings
): LoadedWallet | null => {
    if (env.GUM_SOLANA_SECRET_KEY) {
        return {
            source: "GUM_SOLANA_SECRET_KEY",
            wallet: walletOf({
                kind: "solana",
                secret: env.GUM_SOLANA_SECRET_KEY,
            }),
        };
    }
    if (env.GUM_EVM_PRIVATE_KEY) {
        return {
            source: "GUM_EVM_PRIVATE_KEY",
            wallet: walletOf({ kind: "evm", secret: env.GUM_EVM_PRIVATE_KEY }),
        };
    }
    const [path] = keyFilesOf(settings);
    return path ? { source: path, wallet: readKey(path) } : null;
};

export const requireWallet = (env: Env, settings: Settings): Wallet => {
    const loaded = loadWallet(env, settings);
    if (!loaded) {
        throw new GumError(
            "no_wallet",
            `No wallet to sign with in profile ${settings.profile}. Run \`gumag auth login\` for a fresh bot wallet, or set GUM_SOLANA_SECRET_KEY or GUM_EVM_PRIVATE_KEY.`
        );
    }
    return loaded.wallet;
};

/** Saves a key for the profile, readable by you only. Never replaces one: its funds stay with it. */
export const saveKey = (settings: Settings, stored: StoredWallet) => {
    const [existing] = keyFilesOf(settings);
    if (existing) {
        throw new GumError(
            "wallet_exists",
            `Profile ${settings.profile} already has a wallet (${existing}), and its funds stay with its key. Pick another profile with --profile, or run \`gumag auth logout\` first.`
        );
    }
    const path = keyPathOf(settings.configDir, settings.profile);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
    });
    return path;
};

/** Moves the profile's key files to keys/archive. Keys are never deleted. */
export const archiveKeys = (settings: Settings) => {
    const archive = join(settings.configDir, "keys", "archive");
    const stamp = new Date().toISOString().replaceAll(":", "-");
    return keyFilesOf(settings).map((path, index) => {
        mkdirSync(archive, { mode: 0o700, recursive: true });
        const target = join(
            archive,
            `${settings.profile}-${stamp}${index > 0 ? `-${index}` : ""}.json`
        );
        renameSync(path, target);
        return target;
    });
};

const dollars = (raw: string, name: string) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
        throw new GumError(
            "invalid_request",
            `${name} must be a number of dollars.`
        );
    }
    return value;
};

/**
 * The USD limit for one trade or withdrawal: the lowest of --max-usd,
 * GUM_MAX_TRADE_USD and the profile's, so no single source can raise another.
 */
export const limitOf = (
    flag: number | undefined,
    env: Env,
    settings: Pick<Settings, "profileMaxUsd">
) => {
    const limits: number[] = [];
    if (flag !== undefined) {
        limits.push(dollars(String(flag), "--max-usd"));
    }
    const fromEnv = env.GUM_MAX_TRADE_USD;
    if (fromEnv !== undefined && fromEnv !== "") {
        limits.push(dollars(fromEnv, "GUM_MAX_TRADE_USD"));
    }
    if (settings.profileMaxUsd !== undefined) {
        limits.push(settings.profileMaxUsd);
    }
    return limits.length > 0 ? Math.min(...limits) : undefined;
};

export const parseDollars = dollars;
