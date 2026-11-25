import { createHash } from "node:crypto";
import { z } from "zod";
import type {
    Command,
    Endpoint,
    GeneratedApi,
    Input,
    InputType,
    Operation,
    Resolver,
    Run,
} from "../src/model";
import {
    type ParsedOperation,
    parseOperations,
    type Spec,
} from "../src/openapi";
import { ApiAnnotations, type CommandAnnotation, VERBS } from "./annotations";

// Turns an API's OpenAPI snapshot and its annotations into the CLI's
// commands. Anything wrong with an annotation fails here, when the CLI is
// generated, never in someone's terminal.

/** Top-level names the CLI implements itself. */
export const RESERVED = [
    "api",
    "auth",
    "cli",
    "completion",
    "help",
    "mcp",
    "schema",
    "search",
    "version",
    "whoami",
];

/** Flags every command takes. */
export const GLOBAL_FLAGS = [
    "compact",
    "help",
    "network",
    "pretty",
    "profile",
    "version",
];

const PATH_PARAM = /\{(\w+)\}/g;

const PLACEHOLDERS: Record<string, string> = {
    chain: "id",
    limit: "n",
    "max-usd": "usd",
    slippage: "bps",
    timeout: "seconds",
    to: "address",
};

const fail = (message: string): never => {
    throw new Error(message);
};

const cliInput = (
    field: string,
    flag: string,
    type: InputType,
    description: string
): Input => ({ description, field, flag, in: "cli", required: false, type });

const cliInputsOf = (run: Run): Input[] => {
    switch (run.kind) {
        case "request":
            return run.wait
                ? [
                      cliInput(
                          "wait",
                          "wait",
                          "boolean",
                          `Poll until ${run.wait.until} is true.`
                      ),
                      cliInput(
                          "timeout",
                          "timeout",
                          "integer",
                          `Seconds to keep polling with --wait (default ${run.wait.timeoutSeconds}).`
                      ),
                  ]
                : [];
        case "paginate":
            return [
                cliInput(
                    "all",
                    "all",
                    "boolean",
                    "Follow every page and print one JSON line per item."
                ),
            ];
        case "stream":
            return [
                cliInput(
                    "timeout",
                    "timeout",
                    "integer",
                    "Stop after this many seconds."
                ),
            ];
        case "signed":
            return [
                cliInput(
                    "dryRun",
                    "dry-run",
                    "boolean",
                    "Quote and sign, then have the API check the signature without submitting. Nothing moves."
                ),
                cliInput(
                    "yes",
                    "yes",
                    "boolean",
                    "Don't ask before signing. Required when nobody is at the terminal: without it the command stops with the quote."
                ),
                cliInput(
                    "maxUsd",
                    "max-usd",
                    "number",
                    "Refuse anything above this many dollars. The lowest of this, GUM_MAX_TRADE_USD and the profile's limit applies."
                ),
                ...(run.status
                    ? [
                          cliInput(
                              "noWait",
                              "no-wait",
                              "boolean",
                              "Return once submitted instead of waiting until it's final."
                          ),
                          cliInput(
                              "timeout",
                              "timeout",
                              "integer",
                              `Seconds to wait until it's final (default ${run.waitSeconds ?? 60}).`
                          ),
                      ]
                    : []),
            ];
        default:
            return [];
    }
};

const endpointOf = (operation: ParsedOperation): Endpoint => ({
    method: operation.method,
    operationId: operation.operationId,
    route: operation.route,
});

const routeParams = (route: string) =>
    [...route.matchAll(PATH_PARAM)].map((match) => match[1] ?? "");

const lookup = (
    byId: Map<string, ParsedOperation>,
    operationId: string,
    where: string
) =>
    byId.get(operationId) ??
    fail(`${where} names ${operationId}, which isn't in the spec.`);

const buildRun = (
    operation: ParsedOperation,
    annotation: CommandAnnotation["run"],
    byId: Map<string, ParsedOperation>,
    where: string
): Run => {
    const run = annotation ?? { kind: "request" as const };
    if (operation.stream !== (run.kind === "stream")) {
        fail(
            operation.stream
                ? `${where}: ${operation.operationId} streams, so its run must be { kind: "stream" }.`
                : `${where}: ${operation.operationId} doesn't stream, so it can't run as a stream.`
        );
    }
    const needs = (fields: string[], from: ParsedOperation, what: string) => {
        for (const field of fields) {
            if (!from.response.includes(field)) {
                fail(
                    `${where}: ${what} needs ${field} in ${from.operationId}'s response, which doesn't have it.`
                );
            }
        }
    };
    switch (run.kind) {
        case "request": {
            if (run.wait) {
                needs([run.wait.until], operation, "--wait");
            }
            return {
                kind: "request",
                readOnly: run.readOnly ?? operation.method === "GET",
                ...(run.wait ? { wait: run.wait } : {}),
            };
        }
        case "paginate": {
            if (
                !operation.inputs.some(
                    (input) =>
                        input.in === "query" && input.field === run.cursor
                )
            ) {
                fail(
                    `${where}: ${operation.operationId} has no query parameter ${run.cursor} to page with.`
                );
            }
            needs([run.next, run.items], operation, "--all");
            return run;
        }
        case "stream": {
            if (!run.fallback) {
                return run.until
                    ? { kind: "stream", until: run.until }
                    : { kind: "stream" };
            }
            const fallback = lookup(byId, run.fallback, where);
            if (fallback.method !== "GET" || fallback.stream) {
                fail(
                    `${where}: the fallback ${fallback.operationId} must be a plain GET.`
                );
            }
            const params = routeParams(operation.route);
            for (const param of routeParams(fallback.route)) {
                if (!params.includes(param)) {
                    fail(
                        `${where}: the fallback ${fallback.operationId} needs ${param}, which the stream doesn't take.`
                    );
                }
            }
            if (run.until) {
                needs([run.until], fallback, "the stream's until");
            }
            return {
                fallback: endpointOf(fallback),
                kind: "stream",
                ...(run.until ? { until: run.until } : {}),
            };
        }
        case "signed": {
            if (operation.method !== "POST") {
                fail(`${where}: a signed command quotes with a POST.`);
            }
            needs(
                ["message", "transaction", "signer", run.usd],
                operation,
                "signing"
            );
            const submit = lookup(byId, run.submit, where);
            if (
                submit.method !== "POST" ||
                !["transaction", "signature"].every((field) =>
                    submit.requiredBody.includes(field)
                )
            ) {
                fail(
                    `${where}: the submit ${submit.operationId} must be a POST requiring transaction and signature.`
                );
            }
            if (!run.status) {
                if (!run.expect) {
                    fail(
                        `${where}: a signed command without a status endpoint needs run.expect to validate its synchronous response.`
                    );
                }
                return {
                    expect: run.expect,
                    kind: "signed",
                    ...(run.recovery ? { recovery: run.recovery } : {}),
                    submit: endpointOf(submit),
                    usd: run.usd,
                };
            }
            const status = lookup(byId, run.status, where);
            if (
                status.method !== "GET" ||
                !routeParams(status.route).includes("id")
            ) {
                fail(
                    `${where}: the status ${status.operationId} must be a GET by {id}.`
                );
            }
            needs(["final"], status, "waiting until final");
            return {
                kind: "signed",
                ...(run.recovery ? { recovery: run.recovery } : {}),
                status: endpointOf(status),
                submit: endpointOf(submit),
                usd: run.usd,
                waitSeconds: run.waitSeconds ?? 60,
            };
        }
        default:
            return fail(`${where}: unknown run.`);
    }
};

const placeholderOf = (input: Input) =>
    input.enum
        ? input.enum.join("|")
        : (PLACEHOLDERS[input.flag] ?? input.flag);

const usageOf = (
    path: string[],
    inputs: Input[],
    placeholders: Record<string, string> = {}
) => {
    const positional = inputs
        .filter((input) => input.position !== undefined)
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map((input) => {
            const name = `${placeholders[input.field] ?? input.field}${input.variadic ? "..." : ""}`;
            return input.required ? `<${name}>` : `[${name}]`;
        });
    const flags = inputs
        .filter((input) => input.position === undefined)
        .sort((left, right) => Number(right.required) - Number(left.required))
        .map((input) => {
            const text =
                input.type === "boolean"
                    ? `--${input.flag}`
                    : `--${input.flag} <${placeholderOf(input)}>`;
            return input.required ? text : `[${text}]`;
        });
    return ["gumag", ...path, ...positional, ...flags].join(" ");
};

const checkPositions = (inputs: Input[], where: string) => {
    const positional = inputs
        .filter((input) => input.position !== undefined)
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
    positional.forEach((input, index) => {
        if (input.position !== index) {
            fail(
                `${where}: positions must run 0, 1, 2…; ${input.field} is at ${input.position}.`
            );
        }
        if (input.variadic && index !== positional.length - 1) {
            fail(`${where}: only the last positional can be variadic.`);
        }
        const previous = positional[index - 1];
        if (previous && !previous.required && input.required) {
            fail(
                `${where}: the required ${input.field} can't follow the optional ${previous.field}.`
            );
        }
    });
};

const checkFlags = (inputs: Input[], where: string) => {
    const seen = new Set<string>();
    for (const input of inputs) {
        if (GLOBAL_FLAGS.includes(input.flag)) {
            fail(`${where}: --${input.flag} is a global flag.`);
        }
        if (seen.has(input.flag)) {
            fail(`${where}: two inputs use --${input.flag}.`);
        }
        seen.add(input.flag);
    }
};

const buildCommand = (
    operation: ParsedOperation,
    annotation: CommandAnnotation,
    annotations: ApiAnnotations,
    byId: Map<string, ParsedOperation>
): Command[] => {
    const name = annotation.path.join(" ");
    const where = `${operation.operationId} (${name})`;
    const verb = annotation.path.at(-1) ?? "";
    if (!(VERBS as readonly string[]).includes(verb)) {
        fail(`${where}: "${verb}" isn't a verb; use ${VERBS.join(", ")}.`);
    }
    if (RESERVED.includes(annotation.path[0] ?? "")) {
        fail(`${where}: ${annotation.path[0]} is the CLI's own command.`);
    }
    const params = annotation.params ?? {};
    for (const field of Object.keys(params)) {
        if (!operation.inputs.some((input) => input.field === field)) {
            fail(
                `${where}: params names ${field}, which ${operation.operationId} doesn't take.`
            );
        }
    }

    const hidden: Record<string, Resolver> = {};
    const paths = routeParams(operation.route);
    let inputs: Input[] = [];
    for (const base of operation.inputs) {
        const param = params[base.field] ?? {};
        const resolve = param.resolve ?? annotations.resolve?.[base.field];
        if (param.hidden) {
            hidden[base.field] =
                resolve ??
                fail(`${where}: the hidden ${base.field} needs a resolver.`);
            continue;
        }
        const position =
            param.position ??
            (base.in === "path" ? paths.indexOf(base.field) : undefined);
        inputs.push({
            ...base,
            ...(param.description ? { description: param.description } : {}),
            ...(param.flag ? { flag: param.flag } : {}),
            ...(position === undefined ? {} : { position }),
            ...(resolve ? { resolve } : {}),
            ...(param.variadic ? { variadic: true } : {}),
        });
    }
    const infersChain = inputs.some((input) => input.resolve === "token");
    inputs = inputs.map((input) => ({
        ...input,
        required:
            input.required &&
            input.resolve !== "wallet" &&
            !(infersChain && input.field === "chainId"),
    }));

    const run = buildRun(operation, annotation.run, byId, where);
    inputs = [...inputs, ...cliInputsOf(run)];
    checkPositions(inputs, where);
    checkFlags(inputs, where);

    let mcp: Command["mcp"];
    if (annotation.mcp) {
        for (const field of annotation.mcp.omit ?? []) {
            if (!inputs.some((input) => input.field === field)) {
                fail(`${where}: mcp omits ${field}, which isn't an input.`);
            }
        }
        if (
            run.kind === "signed" &&
            run.status &&
            annotation.mcp.waitSeconds === undefined
        ) {
            fail(
                `${where}: a signed tool with status polling needs mcp.waitSeconds.`
            );
        }
        mcp = {
            description: annotation.mcp.description,
            name: annotation.mcp.tool,
            omit: annotation.mcp.omit ?? [],
            ...(annotation.mcp.waitSeconds === undefined
                ? {}
                : { waitSeconds: annotation.mcp.waitSeconds }),
        };
    }

    const command: Command = {
        examples: annotation.examples ?? [],
        fixed: {},
        hidden,
        inputs,
        keywords: annotation.keywords ?? [],
        ...(mcp ? { mcp } : {}),
        method: operation.method,
        operationId: operation.operationId,
        path: annotation.path,
        route: operation.route,
        run,
        summary: annotation.summary ?? operation.summary,
        usage: usageOf(annotation.path, inputs),
    };

    const shortcuts = (annotation.shortcuts ?? []).map((shortcut) => {
        const at = `${where} shortcut ${shortcut.name}`;
        const fixed = shortcut.fixed ?? {};
        const takes = (field: string) =>
            inputs.find((input) => input.field === field && input.in !== "cli");
        for (const [field, value] of Object.entries(fixed)) {
            const input =
                takes(field) ?? fail(`${at}: fixes ${field}, not an input.`);
            if (input.enum && !input.enum.includes(String(value))) {
                fail(`${at}: ${field} can't be ${value}.`);
            }
        }
        for (const field of shortcut.args) {
            if (!takes(field) || field in fixed) {
                fail(`${at}: ${field} can't be an argument.`);
            }
        }
        const shortcutInputs = inputs
            .filter((input) => !(input.field in fixed))
            .map((input) => {
                const {
                    position: _position,
                    variadic: _variadic,
                    ...rest
                } = input;
                const index = shortcut.args.indexOf(input.field);
                return index >= 0 ? { ...rest, position: index } : rest;
            });
        checkPositions(shortcutInputs, at);
        const placeholders = Object.fromEntries(
            shortcut.args.map((field) => [
                field,
                shortcut.placeholders?.[field] ?? field,
            ])
        );
        const { mcp: _tool, ...base } = command;
        return {
            ...base,
            examples: shortcut.examples ?? [],
            fixed,
            inputs: shortcutInputs,
            keywords: shortcut.keywords ?? [],
            path: [shortcut.name],
            shortcutOf: name,
            summary: shortcut.summary,
            usage: usageOf([shortcut.name], shortcutInputs, placeholders),
        } satisfies Command;
    });
    return [command, ...shortcuts];
};

const stubFor = (operation: ParsedOperation) =>
    [
        `${operation.operationId} (${operation.method} ${operation.route}) has no annotation. Add one to the API's cli.ts, e.g.`,
        `    ${operation.operationId}: { commands: [{ path: ["<resource>", "<verb>"] }] },`,
        "or leave it out of the CLI, with a reason:",
        `    ${operation.operationId}: { exclude: "<why>" },`,
    ].join("\n");

/** The CLI's commands for one API: its snapshot plus its annotations. */
export const buildApi = (spec: Spec, value: unknown): GeneratedApi => {
    const parsed = ApiAnnotations.safeParse(value);
    if (!parsed.success) {
        throw new Error(
            `Invalid annotations: ${z.prettifyError(parsed.error)}`
        );
    }
    const annotations = parsed.data;
    const operations = parseOperations(spec, annotations.flags);
    const byId = new Map<string, ParsedOperation>();
    for (const operation of operations) {
        if (byId.has(operation.operationId)) {
            fail(`${operation.operationId} appears twice in the spec.`);
        }
        byId.set(operation.operationId, operation);
    }
    for (const operation of operations) {
        if (!(operation.operationId in annotations.operations)) {
            fail(stubFor(operation));
        }
    }
    for (const operationId of Object.keys(annotations.operations)) {
        if (!byId.has(operationId)) {
            fail(`${operationId} is annotated but isn't in the spec.`);
        }
    }

    const commands: Command[] = [];
    const generated: Operation[] = [];
    for (const operation of operations) {
        const entry = annotations.operations[operation.operationId];
        const exclude = entry && "exclude" in entry ? entry.exclude : undefined;
        if (operation.requiredBody.includes("signature") && !exclude) {
            fail(
                `${operation.operationId} takes a signature: exclude it, so only a signed command can submit it.`
            );
        }
        if (entry && "commands" in entry) {
            for (const annotation of entry.commands) {
                commands.push(
                    ...buildCommand(operation, annotation, annotations, byId)
                );
            }
        }
        generated.push({
            description: operation.description,
            ...(exclude ? { exclude } : {}),
            inputs: operation.inputs,
            method: operation.method,
            operationId: operation.operationId,
            route: operation.route,
            stream: operation.stream,
            summary: operation.summary,
        });
    }

    const names = new Set<string>();
    const resources = new Set(
        commands
            .filter((command) => !command.shortcutOf)
            .map((command) => command.path[0])
    );
    const tools = new Set<string>();
    const flagOf = new Map<string, string>();
    for (const command of commands) {
        const name = command.path.join(" ");
        if (names.has(name)) {
            fail(`Two commands are called ${name}.`);
        }
        names.add(name);
        if (command.shortcutOf && resources.has(name)) {
            fail(`The shortcut ${name} would hide the ${name} commands.`);
        }
        if (command.shortcutOf && RESERVED.includes(name)) {
            fail(`The shortcut ${name} is the CLI's own command.`);
        }
        if (command.mcp) {
            if (tools.has(command.mcp.name)) {
                fail(`Two MCP tools are called ${command.mcp.name}.`);
            }
            tools.add(command.mcp.name);
        }
        for (const input of command.inputs) {
            if (input.in === "cli") {
                continue;
            }
            const flag = flagOf.get(input.field);
            if (flag && flag !== input.flag) {
                fail(
                    `${input.field} is --${flag} in one command and --${input.flag} in another; use one flag.`
                );
            }
            flagOf.set(input.field, input.flag);
        }
    }

    return {
        api: annotations.api,
        commands,
        operations: generated,
        server: spec.servers?.[0]?.url ?? "",
        specSha256: createHash("sha256")
            .update(JSON.stringify(spec))
            .digest("hex"),
        title: spec.info?.title ?? annotations.api,
        version: spec.info?.version ?? "",
    };
};
