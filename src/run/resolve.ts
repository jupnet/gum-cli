import type { Context } from "../context";
import type { Command } from "../model";
import { requireWallet } from "../profile";
import { resolveToken } from "../tokens";
import type { Values } from "./values";

/**
 * Fills what the CLI knows itself: the wallet's address where none was given
 * (and always for the signer), and a symbol's token address, plus its chain
 * when the command left the chain out.
 */
export const resolveValues = async (
    command: Command,
    values: Values,
    context: Context
) => {
    const address = () => requireWallet(context.env, context.settings).address;
    for (const [field, resolver] of Object.entries(command.hidden)) {
        if (resolver === "wallet") {
            values[field] = address();
        }
    }
    for (const input of command.inputs) {
        const value = values[input.field];
        if (!input.resolve || input.in === "cli") {
            continue;
        }
        if (input.resolve === "wallet") {
            if (value === undefined || value === "") {
                values[input.field] = address();
            }
            continue;
        }
        if (typeof value !== "string") {
            continue;
        }
        if (
            input.resolve === "token-or-usd" &&
            value.trim().toUpperCase() === "USD"
        ) {
            values[input.field] = "USD";
            continue;
        }
        const chainId =
            typeof values.chainId === "number" ? values.chainId : undefined;
        const token = await resolveToken(context.api, value, chainId);
        values[input.field] = token.address;
        if (
            input.resolve === "token" &&
            chainId === undefined &&
            command.inputs.some((candidate) => candidate.field === "chainId")
        ) {
            values.chainId = token.chainId;
        }
    }
    return values;
};
