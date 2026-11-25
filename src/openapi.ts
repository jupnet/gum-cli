import type { Input, InputType } from "./model";

// The slice of OpenAPI 3.1 the CLI reads. codegen/build.ts parses the
// snapshot with it at build time; `gumag api` and MCP's search_api/call_api
// parse the live spec with it, for operations newer than this build.

export type Schema = {
    $ref?: string;
    description?: string;
    enum?: unknown[];
    maximum?: number;
    minimum?: number;
    properties?: Record<string, Schema>;
    required?: string[];
    type?: string | string[];
};

type SpecParameter = {
    description?: string;
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Schema;
};

type SpecOperation = {
    description?: string;
    operationId?: string;
    parameters?: SpecParameter[];
    requestBody?: { content?: Record<string, { schema?: Schema }> };
    responses?: Record<
        string,
        { content?: Record<string, { schema?: Schema } | undefined> }
    >;
    summary?: string;
};

export type Spec = {
    components?: { schemas?: Record<string, Schema> };
    info?: { title?: string; version?: string };
    paths?: Record<string, Record<string, SpecOperation>>;
    servers?: { url?: string }[];
};

export type ParsedOperation = {
    description: string;
    inputs: Input[];
    method: "GET" | "POST";
    operationId: string;
    /** Body fields the API requires, e.g. a signed submit's `signature`. */
    requiredBody: string[];
    /** Top-level fields of the success response. */
    response: string[];
    route: string;
    stream: boolean;
    summary: string;
};

const SCHEMA_REF = /^#\/components\/schemas\//;
const CAMEL = /([a-z0-9])([A-Z])/g;
const INPUT_TYPES = new Set<string>([
    "array",
    "boolean",
    "integer",
    "number",
    "object",
    "string",
]);

export const kebab = (name: string) =>
    name.replace(CAMEL, "$1-$2").toLowerCase();

const resolved = (spec: Spec, schema: Schema | undefined) =>
    schema?.$ref
        ? spec.components?.schemas?.[schema.$ref.replace(SCHEMA_REF, "")]
        : schema;

/** The first non-null JSON type; untyped fields are taken as text. */
const typeOf = (schema: Schema | undefined): InputType => {
    const type = [schema?.type ?? []]
        .flat()
        .find((candidate) => candidate !== "null");
    return type !== undefined && INPUT_TYPES.has(type)
        ? (type as InputType)
        : "string";
};

const inputOf = (
    field: string,
    where: "body" | "path" | "query",
    required: boolean,
    schema: Schema | undefined,
    flags: Record<string, string>,
    description?: string
): Input => ({
    description: schema?.description ?? description ?? "",
    ...(schema?.enum ? { enum: schema.enum.map(String) } : {}),
    field,
    flag: flags[field] ?? kebab(field),
    in: where,
    ...(schema?.maximum === undefined ? {} : { maximum: schema.maximum }),
    ...(schema?.minimum === undefined ? {} : { minimum: schema.minimum }),
    required,
    type: typeOf(schema),
});

const successSchema = (spec: Spec, operation: SpecOperation) => {
    for (const status of ["200", "201", "202"]) {
        const schema =
            operation.responses?.[status]?.content?.["application/json"]
                ?.schema;
        if (schema) {
            return resolved(spec, schema);
        }
    }
};

/**
 * Every GET and POST operation with an operationId. `flags` names the flag
 * for a field; any other field's flag is its name in kebab case.
 */
export const parseOperations = (
    spec: Spec,
    flags: Record<string, string> = {}
): ParsedOperation[] => {
    const found: ParsedOperation[] = [];
    for (const [route, methods] of Object.entries(spec.paths ?? {})) {
        for (const [method, operation] of Object.entries(methods)) {
            const upper = method.toUpperCase();
            if (
                !operation?.operationId ||
                (upper !== "GET" && upper !== "POST")
            ) {
                continue;
            }
            const inputs: Input[] = [];
            for (const parameter of operation.parameters ?? []) {
                if (
                    parameter.name &&
                    (parameter.in === "path" || parameter.in === "query")
                ) {
                    inputs.push(
                        inputOf(
                            parameter.name,
                            parameter.in,
                            parameter.in === "path" ||
                                parameter.required === true,
                            parameter.schema,
                            flags,
                            parameter.description
                        )
                    );
                }
            }
            const body = resolved(
                spec,
                operation.requestBody?.content?.["application/json"]?.schema
            );
            const requiredBody = body?.required ?? [];
            for (const [field, schema] of Object.entries(
                body?.properties ?? {}
            )) {
                inputs.push(
                    inputOf(
                        field,
                        "body",
                        requiredBody.includes(field),
                        resolved(spec, schema),
                        flags
                    )
                );
            }
            found.push({
                description: operation.description ?? "",
                inputs,
                method: upper,
                operationId: operation.operationId,
                requiredBody,
                response: Object.keys(
                    successSchema(spec, operation)?.properties ?? {}
                ),
                route,
                stream: Object.values(operation.responses ?? {}).some(
                    (response) =>
                        response.content?.["text/event-stream"] !== undefined
                ),
                summary: operation.summary ?? "",
            });
        }
    }
    return found;
};
