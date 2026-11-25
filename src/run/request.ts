import type { Context } from "../context";
import type { Command, Operation } from "../model";
import { waitUntil } from "../trade";
import { type Options, requestOf, timeoutMs, type Values } from "./values";

/** A quote without the bytes to sign: what a person or an agent reads. */
export const pricedOf = (value: unknown) => {
    if (
        value &&
        typeof value === "object" &&
        "message" in value &&
        "transaction" in value
    ) {
        const {
            message: _message,
            transaction: _transaction,
            ...rest
        } = value as Record<string, unknown>;
        return rest;
    }
    return value;
};

export const callOperation = (
    context: Context,
    operation: Operation,
    values: Values
) => {
    const { body, path, query } = requestOf(operation, values);
    return operation.method === "GET"
        ? context.api.get<unknown>(path, query)
        : context.api.post<unknown>(path, body);
};

/** One call; with --wait, polled until the run's `until` field is true. */
export const runRequest = async (
    command: Command,
    operation: Operation,
    context: Context,
    values: Values,
    options: Options
) => {
    const read = () => callOperation(context, operation, values);
    const { run } = command;
    if (run.kind === "request" && run.wait && options.wait === true) {
        return waitUntil(
            read,
            run.wait.until,
            timeoutMs(options, run.wait.timeoutSeconds)
        );
    }
    return pricedOf(await read());
};
