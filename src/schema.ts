import type { Input, Run } from "./model";
import { type AnyCommand, isMeta, operationById } from "./tree";

const describeInput = (input: Input) => ({
    ...(input.position === undefined
        ? { flag: `--${input.flag}` }
        : { argument: `<${input.field}>`, position: input.position }),
    description: input.description,
    ...(input.enum ? { enum: input.enum } : {}),
    field: input.field,
    in: input.in,
    ...(input.maximum === undefined ? {} : { maximum: input.maximum }),
    ...(input.minimum === undefined ? {} : { minimum: input.minimum }),
    required: input.required,
    ...(input.resolve ? { resolve: input.resolve } : {}),
    type: input.type,
    ...(input.variadic ? { variadic: true } : {}),
});

const describeRun = (run: Run) => {
    switch (run.kind) {
        case "paginate":
            return {
                all: `--all follows ${run.next} and prints one ${run.items} entry per line`,
                kind: run.kind,
            };
        case "signed":
            return {
                kind: run.kind,
                limitField: run.usd,
                ...(run.status ? { status: run.status.operationId } : {}),
                submits: run.submit.operationId,
            };
        case "stream":
            return {
                kind: run.kind,
                ...(run.until ? { until: run.until } : {}),
                ...(run.fallback ? { fallback: run.fallback.operationId } : {}),
            };
        default:
            return {
                kind: run.kind,
                readOnly: run.readOnly,
                ...(run.wait ? { waitUntil: run.wait.until } : {}),
            };
    }
};

/** Everything `gumag schema <command>` says: inputs, types, the operation behind it. */
export const schemaOf = (command: AnyCommand) => {
    const generated = isMeta(command) ? undefined : command;
    const operation = generated
        ? operationById(generated.operationId)
        : undefined;
    return {
        command: `gumag ${command.path.join(" ")}`,
        summary: command.summary,
        usage: command.usage,
        ...(command.shortcutOf
            ? { shortcutOf: `gumag ${command.shortcutOf}` }
            : {}),
        ...(generated
            ? {
                  httpMethod: generated.method,
                  operationId: generated.operationId,
                  path: generated.route,
                  run: describeRun(generated.run),
                  ...(Object.keys(generated.fixed).length > 0
                      ? { fixed: generated.fixed }
                      : {}),
                  ...(operation?.description
                      ? { description: operation.description }
                      : {}),
              }
            : {}),
        arguments: command.inputs
            .filter((input) => input.position !== undefined)
            .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
            .map(describeInput),
        examples: command.examples,
        flags: command.inputs
            .filter((input) => input.position === undefined)
            .map(describeInput),
    };
};
