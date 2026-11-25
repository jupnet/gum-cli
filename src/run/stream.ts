import { GumError } from "../api";
import type { Context } from "../context";
import type { Command, Operation } from "../model";
import { operationById } from "../tree";
import { callOperation } from "./request";
import { type Options, requestOf, type Values } from "./values";

const POLL_MS = 2000;
/** How long polling goes on without --timeout, once the stream is gone. */
const POLL_LIMIT_MS = 30 * 60 * 1000;

const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });

/**
 * Follows a server-sent stream, one JSON line per message, until a message
 * has `until` true, --timeout passes or the server ends it. When the stream
 * can't be opened or drops, it polls the fallback operation instead, printing
 * a line only when the answer changes.
 */
export const runStream = async (
    command: Command,
    operation: Operation,
    context: Context,
    values: Values,
    options: Options
) => {
    const { run } = command;
    if (run.kind !== "stream") {
        return;
    }
    const controller = new AbortController();
    const arm = (ms: number) => setTimeout(() => controller.abort(), ms);
    let timer =
        typeof options.timeout === "number"
            ? arm(options.timeout * 1000)
            : undefined;
    const done = (message: unknown) =>
        run.until !== undefined &&
        (message as Record<string, unknown> | null)?.[run.until] === true;

    const poll = async () => {
        const fallback = run.fallback
            ? operationById(run.fallback.operationId)
            : undefined;
        if (!fallback) {
            return;
        }
        timer ??= arm(POLL_LIMIT_MS);
        let last = "";
        while (!controller.signal.aborted) {
            const message = await callOperation(context, fallback, values);
            const text = JSON.stringify(message);
            if (text !== last) {
                context.emit(message);
                last = text;
            }
            if (done(message)) {
                return;
            }
            await pause(POLL_MS, controller.signal);
        }
    };

    const recoverable = (error: unknown) =>
        run.fallback !== undefined &&
        !(
            error instanceof GumError &&
            error.status !== null &&
            error.status < 500
        );

    try {
        let events: AsyncIterable<unknown>;
        try {
            events = await context.api.stream(
                requestOf(operation, values).path,
                controller.signal
            );
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            if (!recoverable(error)) {
                throw error;
            }
            return await poll();
        }
        try {
            for await (const message of events) {
                context.emit(message);
                if (done(message)) {
                    return;
                }
            }
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            if (!recoverable(error)) {
                throw error;
            }
        }
        if (run.until !== undefined && !controller.signal.aborted) {
            await poll();
        }
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
};
