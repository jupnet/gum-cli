import { GumError, type Query } from "../api";
import type { Flags } from "../args";
import type { Input, Operation } from "../model";
import type { Described } from "../tree";
import { fromText } from "../validate";

/** API fields by name, as the operation takes them. */
export type Values = Record<string, unknown>;
/** The CLI's own inputs: dryRun, yes, maxUsd, noWait, timeout, wait, all. */
export type Options = Record<string, unknown>;

const PATH_PARAM = /\{(\w+)\}/g;

const invalid = (message: string) => new GumError("invalid_request", message);

const labelOf = (input: Input) =>
    input.position === undefined ? `--${input.flag}` : `<${input.field}>`;

const listed = (names: string[]) =>
    names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : (names[0] ?? "");

/** Turns a command's positional arguments and flags into typed values. */
export const collect = (
    command: Described,
    positionals: string[],
    flags: Flags
) => {
    const values: Values = {};
    const options: Options = {};
    const set = (input: Input, value: unknown) => {
        (input.in === "cli" ? options : values)[input.field] = value;
    };
    const ordered = command.inputs
        .filter((input) => input.position !== undefined)
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
    let index = 0;
    for (const input of ordered) {
        if (index >= positionals.length) {
            break;
        }
        if (input.variadic) {
            set(
                input,
                fromText(
                    input,
                    positionals.slice(index).join(" "),
                    `<${input.field}>`
                )
            );
            index = positionals.length;
            break;
        }
        set(
            input,
            fromText(input, positionals[index] ?? "", `<${input.field}>`)
        );
        index += 1;
    }
    if (index < positionals.length) {
        throw invalid(
            `Unexpected ${positionals.slice(index).join(" ")}. Usage: ${command.usage}`
        );
    }
    for (const [flag, raw] of Object.entries(flags)) {
        const input = command.inputs.find(
            (candidate) => candidate.flag === flag
        );
        if (!input) {
            continue;
        }
        if (
            (input.in === "cli" ? options : values)[input.field] !== undefined
        ) {
            throw invalid(
                `${input.field} is given twice: as an argument and as --${flag}.`
            );
        }
        set(input, fromText(input, raw, `--${flag}`));
    }
    const missing = command.inputs.filter(
        (input) =>
            input.required &&
            (input.in === "cli" ? options : values)[input.field] === undefined
    );
    if (missing.length > 0) {
        throw invalid(
            `${command.path.join(" ")} needs ${listed(missing.map(labelOf))}. Usage: ${command.usage}`
        );
    }
    return { options, values };
};

/** The request an operation takes for these values: path, query and JSON body. */
export const requestOf = (operation: Operation, values: Values) => {
    const path = operation.route.replace(PATH_PARAM, (_, name: string) => {
        const value = values[name];
        if (value === undefined || value === "") {
            throw invalid(`Missing ${name}.`);
        }
        return encodeURIComponent(String(value));
    });
    const query: Query = {};
    const body: Record<string, unknown> = {};
    for (const input of operation.inputs) {
        const value = values[input.field];
        if (value === undefined) {
            continue;
        }
        if (input.in === "query") {
            query[input.field] =
                typeof value === "number" ? value : String(value);
        } else if (input.in === "body") {
            body[input.field] = value;
        }
    }
    return { body, path, query };
};

/** Seconds from --timeout, else the command's default, in milliseconds. */
export const timeoutMs = (options: Options, defaultSeconds: number) => {
    const seconds = options.timeout;
    return (typeof seconds === "number" ? seconds : defaultSeconds) * 1000;
};
