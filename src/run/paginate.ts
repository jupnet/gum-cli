import type { Context } from "../context";
import type { Command, Operation } from "../model";
import { callOperation } from "./request";
import type { Options, Values } from "./values";

/** Enough for any real history; past it, --cursor picks up where this stopped. */
export const MAX_PAGES = 100;

/** One page, or with --all every page as one JSON line per item. */
export const runPaginate = async (
    command: Command,
    operation: Operation,
    context: Context,
    values: Values,
    options: Options
) => {
    const { run } = command;
    if (run.kind !== "paginate" || options.all !== true) {
        return callOperation(context, operation, values);
    }
    let cursor = values[run.cursor];
    for (let page = 1; ; page += 1) {
        const answer = (await callOperation(context, operation, {
            ...values,
            [run.cursor]: cursor,
        })) as Record<string, unknown> | null;
        const items = answer?.[run.items];
        for (const item of Array.isArray(items) ? items : []) {
            context.emit(item);
        }
        const next = answer?.[run.next];
        if (typeof next !== "string" || next === "") {
            return;
        }
        if (page >= MAX_PAGES) {
            context.io.stderr(
                `${JSON.stringify({ notice: `Stopped after ${MAX_PAGES} pages. Continue with --cursor ${next}.` })}\n`
            );
            return;
        }
        cursor = next;
    }
};
