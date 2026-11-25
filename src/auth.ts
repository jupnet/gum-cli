import { GumError } from "./api";
import type { Context } from "./context";
import {
    archiveKeys,
    checkProfileName,
    loadWallet,
    parseDollars,
    readConfig,
    resolveSettings,
    saveKey,
    writeConfig,
} from "./profile";
import type { Options } from "./run/values";
import { importKey, newKey, walletOf } from "./wallet";

// Phase one of `gumag auth`: the account is a wallet whose key lives on this
// machine. A browser login to an existing GUM account comes later.

/** Where the key comes from and what this profile runs against. */
export const authStatus = (context: Context) => {
    const { settings } = context;
    const loaded = loadWallet(context.env, settings);
    if (!loaded) {
        throw new GumError(
            "no_wallet",
            `No wallet in profile ${settings.profile}. Run \`gumag auth login\` for a fresh bot wallet, or set GUM_SOLANA_SECRET_KEY or GUM_EVM_PRIVATE_KEY.`,
            {
                details: {
                    profiles: Object.keys(
                        readConfig(settings.configDir).profiles
                    ),
                },
            }
        );
    }
    return {
        address: loaded.wallet.address,
        apiUrl: settings.apiUrl,
        kind: loaded.wallet.kind,
        maxTradeUsd: settings.profileMaxUsd ?? null,
        network: settings.network,
        profile: settings.profile,
        profiles: Object.keys(readConfig(settings.configDir).profiles),
        source: loaded.source,
    };
};

/** Creates (or with --import, takes) this profile's key and makes the profile the default. */
export const authLogin = async (
    context: Context,
    options: Options,
    network: string | undefined
) => {
    const { settings } = context;
    const config = readConfig(settings.configDir);
    const maxTradeUsd =
        typeof options.maxUsd === "number"
            ? parseDollars(String(options.maxUsd), "--max-usd")
            : config.profiles[settings.profile]?.maxTradeUsd;
    let stored = newKey(options.evm === true ? "evm" : "solana");
    if (options.import === true) {
        const raw = context.io.stdinTerminal
            ? await context.io.secret(
                  "Paste the key (Solana base58 or EVM hex): "
              )
            : await context.io.readStdin();
        stored = importKey(raw);
    }
    const saved = saveKey(settings, stored);
    config.profiles[settings.profile] = {
        ...config.profiles[settings.profile],
        ...(network === "devnet" || network === "mainnet" ? { network } : {}),
        ...(maxTradeUsd === undefined ? {} : { maxTradeUsd }),
    };
    config.profile = settings.profile;
    writeConfig(settings.configDir, config);
    const wallet = walletOf(stored);
    const now = resolveSettings(context.env, { profile: settings.profile });
    return {
        address: wallet.address,
        kind: wallet.kind,
        maxTradeUsd: maxTradeUsd ?? null,
        network: now.network,
        next: "Fund it from `gumag deposit`: it lists a deposit address per chain.",
        profile: settings.profile,
        saved,
    };
};

/** Stops using this profile's key; the key file moves to keys/archive. */
export const authLogout = (context: Context) => {
    const { settings } = context;
    if (context.env.GUM_SOLANA_SECRET_KEY || context.env.GUM_EVM_PRIVATE_KEY) {
        throw new GumError(
            "invalid_request",
            "The key comes from GUM_SOLANA_SECRET_KEY or GUM_EVM_PRIVATE_KEY: unset it instead."
        );
    }
    const archived = archiveKeys(settings);
    if (archived.length === 0) {
        throw new GumError(
            "no_wallet",
            `Profile ${settings.profile} has no key to log out of.`
        );
    }
    return {
        archived,
        note: "The key was moved, not deleted: its wallet may still hold funds.",
        profile: settings.profile,
    };
};

/** Makes a profile the default for later commands. */
export const authUse = (context: Context, profile: string) => {
    const name = checkProfileName(profile);
    const config = readConfig(context.settings.configDir);
    const settings = resolveSettings(context.env, { profile: name });
    const loaded = loadWallet({}, settings);
    if (!(config.profiles[name] || loaded)) {
        throw new GumError(
            "unknown_profile",
            `No profile ${name}. Create it with \`gumag auth login --profile ${name}\`.`,
            { details: { profiles: Object.keys(config.profiles) } }
        );
    }
    config.profile = name;
    config.profiles[name] ??= {};
    writeConfig(context.settings.configDir, config);
    return {
        address: loaded?.wallet.address ?? null,
        network: settings.network,
        profile: name,
    };
};
