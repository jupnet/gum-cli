import { GumError } from "../api";
import type { Context } from "../context";
import type { Command } from "../model";
import { requireWallet } from "../profile";
import { operationById } from "../tree";
import { runPaginate } from "./paginate";
import { runRequest } from "./request";
import { resolveValues } from "./resolve";
import { limitFor, runSigned } from "./signed";
import { runStream } from "./stream";
import { type Options, timeoutMs, type Values } from "./values";

/** Runs a generated command with its collected values and the CLI's own options. */
export const runGenerated = async (
    command: Command,
    context: Context,
    values: Values,
    options: Options
) => {
    const operation = operationById(command.operationId);
    if (!operation) {
        throw new GumError(
            "internal_error",
            `No operation ${command.operationId}.`
        );
    }
    const { run } = command;
    const signedOptions = {
        dryRun: options.dryRun === true,
        ...(typeof options.maxUsd === "number"
            ? { maxUsd: options.maxUsd }
            : {}),
        requireLimit: options.requireLimit === true,
    };
    if (run.kind === "signed") {
        limitFor(context, signedOptions);
        requireWallet(context.env, context.settings);
    }
    const filled = await resolveValues(
        command,
        { ...values, ...command.fixed },
        context
    );
    switch (run.kind) {
        case "paginate":
            return runPaginate(command, operation, context, filled, options);
        case "stream":
            return runStream(command, operation, context, filled, options);
        case "signed":
            return runSigned(command, operation, context, filled, {
                ...signedOptions,
                timeoutMs: timeoutMs(options, run.waitSeconds ?? 60),
                wait: Boolean(run.status) && options.noWait !== true,
                yes: options.yes === true,
            });
        default:
            return runRequest(command, operation, context, filled, options);
    }
};
