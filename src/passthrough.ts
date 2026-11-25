import { readFileSync } from "node:fs";
import { GumError } from "./api";
import type { Flags } from "./args";
import type { Context } from "./context";
import { liveOnlyOperations } from "./live";
import type { Operation } from "./model";
import { requireWallet } from "./profile";
import { requestOf, type Values } from "./run/values";
import { COMMANDS, isMeta, operationById, TRADING_API } from "./tree";
import { fromJson, fromText } from "./validate";

// `gumag api <operationId>` and MCP's call_api: any operation by id, the
// ones newer than this build included. Signed submits are refused (only the
// signed commands sign, after the USD limit and confirmation), and so are
// streams, which have watch commands.

const callable = (operation: Operation) =>
    !(operation.exclude || operation.stream);

export const findOperation = async (
    context: Context,
    operationId: string
): Promise<Operation> => {
    const wanted = operationId.toLowerCase();
    const operation =
        operationById(operationId) ??
        (await liveOnlyOperations(context.api, context.env)).find(
            (candidate) => candidate.operationId.toLowerCase() === wanted
        );
    if (!operation) {
        throw new GumError(
            "unknown_operation",
            `No operation ${operationId}. Find one with \`gumag cli search\`.`,
            {
                details: {
                    operations: TRADING_API.operations
                        .filter(callable)
                        .map((candidate) => candidate.operationId),
                },
            }
        );
    }
    if (operation.exclude) {
        throw new GumError("use_signed_command", operation.exclude);
    }
    if (operation.stream) {
        const watch = COMMANDS.find(
            (command) =>
                !isMeta(command) &&
                command.operationId === operation.operationId
        );
        throw new GumError(
            "use_watch_command",
            `${operation.operationId} streams. Follow it with \`gumag ${watch?.path.join(" ") ?? "… watch"}\`.`
        );
    }
    return operation;
};

const readBody = async (context: Context, raw: string) => {
    let text = raw;
    if (raw === "@-") {
        text = await context.io.readStdin();
    } else if (raw.startsWith("@")) {
        try {
            text = readFileSync(raw.slice(1), "utf8");
        } catch (error) {
            throw new GumError(
                "invalid_request",
                `Couldn't read ${raw.slice(1)}.`,
                { cause: error }
            );
        }
    }
    try {
        const body = JSON.parse(text) as unknown;
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
            return body as Values;
        }
    } catch {
        // Reported below.
    }
    throw new GumError("invalid_request", "--body must be a JSON object.");
};

/** An address path parameter defaults to your wallet, as on the commands. */
const withWallet = (context: Context, operation: Operation, values: Values) => {
    if (
        values.address === undefined &&
        operation.inputs.some(
            (input) => input.in === "path" && input.field === "address"
        )
    ) {
        values.address = requireWallet(context.env, context.settings).address;
    }
    return values;
};

const send = async (
    context: Context,
    operation: Operation,
    values: Values,
    dryRun: boolean
) => {
    const { body, path, query } = requestOf(operation, values);
    if (dryRun) {
        const url = new URL(`${context.api.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return {
            dryRun: true,
            method: operation.method,
            url: url.toString(),
            ...(operation.method === "POST" ? { body } : {}),
        };
    }
    return operation.method === "GET"
        ? context.api.get<unknown>(path, query)
        : context.api.post<unknown>(path, body);
};

/** `gumag api <operationId> --<field> <value>… [--body <json|@file|@->] [--dry-run]` */
export const callFromFlags = async (
    context: Context,
    operationId: string,
    flags: Flags
) => {
    const operation = await findOperation(context, operationId);
    const { body, "dry-run": dryRun, ...rest } = flags;
    if (body === true) {
        throw new GumError("invalid_request", "--body needs a value.");
    }
    const values: Values =
        typeof body === "string" ? await readBody(context, body) : {};
    for (const [flag, raw] of Object.entries(rest)) {
        const input = operation.inputs.find(
            (candidate) => candidate.flag === flag || candidate.field === flag
        );
        if (!input) {
            const takes = operation.inputs.map(
                (candidate) => `--${candidate.flag}`
            );
            throw new GumError(
                "invalid_request",
                `${operation.operationId} has no --${flag}. ${takes.length > 0 ? `It takes ${takes.join(", ")}.` : "It takes no flags."}`
            );
        }
        values[input.field] = fromText(input, raw, `--${flag}`);
    }
    return send(
        context,
        operation,
        withWallet(context, operation, values),
        dryRun === true
    );
};

/** MCP's call_api: params fill path and query parameters, body is the JSON body. */
export const callFromJson = async (
    context: Context,
    operationId: string,
    params: Record<string, unknown> = {},
    body: Record<string, unknown> = {}
) => {
    const operation = await findOperation(context, operationId);
    const values: Values = { ...body };
    for (const [name, value] of Object.entries(params)) {
        const input = operation.inputs.find(
            (candidate) => candidate.field === name && candidate.in !== "body"
        );
        if (!input) {
            throw new GumError(
                "invalid_request",
                `${operation.operationId} has no parameter ${name}.`
            );
        }
        values[name] =
            typeof value === "string"
                ? fromText(input, value, name)
                : fromJson(input, value, name);
    }
    return send(
        context,
        operation,
        withWallet(context, operation, values),
        false
    );
};
