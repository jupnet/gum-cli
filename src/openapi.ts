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

const SCHEMA_REF_PREFIX = "#/components/schemas/";
const SAFE_ROUTE = /^\/[^\s?#\\]*$/;
const CAMEL = /([a-z0-9])([A-Z])/g;
const INPUT_TYPES = new Set<string>([
    "array",
    "boolean",
    "integer",
    "number",
    "object",
    "string",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeRoute = (route: string) =>
    SAFE_ROUTE.test(route) &&
    !route.startsWith("//") &&
    !route.split("/").some((segment) => segment === "." || segment === "..");

export const kebab = (name: string) =>
    name.replace(CAMEL, "$1-$2").toLowerCase();

const resolved = (
    spec: Spec,
    schema: Schema | undefined
): Schema | undefined => {
    if (!isRecord(schema)) {
        return;
    }
    if (typeof schema.$ref === "string") {
        if (!schema.$ref.startsWith(SCHEMA_REF_PREFIX)) {
            return;
        }
        const name = schema.$ref.slice(SCHEMA_REF_PREFIX.length);
        const schemas = spec.components?.schemas;
        if (
            !name ||
            name.includes("/") ||
            !isRecord(schemas) ||
            !Object.hasOwn(schemas, name)
        ) {
            return;
        }
        const target = schemas[name];
        return isRecord(target) ? (target as Schema) : undefined;
    }
    return schema;
};

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
    ...(Array.isArray(schema?.enum) ? { enum: schema.enum.map(String) } : {}),
    field,
    flag: Object.hasOwn(flags, field)
        ? (flags[field] ?? kebab(field))
        : kebab(field),
    in: where,
    ...(typeof schema?.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(typeof schema?.minimum === "number" ? { minimum: schema.minimum } : {}),
    required,
    type: typeOf(schema),
});

const successSchema = (spec: Spec, operation: SpecOperation) => {
    if (!isRecord(operation.responses)) {
        return;
    }
    for (const status of ["200", "201", "202"]) {
        const response = operation.responses[status];
        const schema = isRecord(response)
            ? response.content?.["application/json"]?.schema
            : undefined;
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
    if (!(isRecord(spec) && isRecord(spec.paths))) {
        return [];
    }
    const found: ParsedOperation[] = [];
    for (const [route, methods] of Object.entries(spec.paths)) {
        if (!(isSafeRoute(route) && isRecord(methods))) {
            continue;
        }
        for (const [method, operation] of Object.entries(methods)) {
            const upper = method.toUpperCase();
            if (
                !isRecord(operation) ||
                typeof operation.operationId !== "string" ||
                operation.operationId.trim() === "" ||
                (upper !== "GET" && upper !== "POST")
            ) {
                continue;
            }
            const inputs: Input[] = [];
            for (const parameter of Array.isArray(operation.parameters)
                ? operation.parameters
                : []) {
                if (
                    isRecord(parameter) &&
                    typeof parameter.name === "string" &&
                    parameter.name !== "" &&
                    (parameter.in === "path" || parameter.in === "query")
                ) {
                    inputs.push(
                        inputOf(
                            parameter.name,
                            parameter.in,
                            parameter.in === "path" ||
                                parameter.required === true,
                            resolved(spec, parameter.schema),
                            flags,
                            typeof parameter.description === "string"
                                ? parameter.description
                                : undefined
                        )
                    );
                }
            }
            const body = resolved(
                spec,
                operation.requestBody?.content?.["application/json"]?.schema
            );
            const requiredBody = Array.isArray(body?.required)
                ? body.required.filter(
                      (field): field is string => typeof field === "string"
                  )
                : [];
            if (isRecord(body?.properties)) {
                for (const [field, schema] of Object.entries(body.properties)) {
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
            }
            const responseSchema = successSchema(spec, operation);
            const responses = isRecord(operation.responses)
                ? Object.values(operation.responses)
                : [];
            found.push({
                description:
                    typeof operation.description === "string"
                        ? operation.description
                        : "",
                inputs,
                method: upper,
                operationId: operation.operationId,
                requiredBody,
                response: isRecord(responseSchema?.properties)
                    ? Object.keys(responseSchema.properties)
                    : [],
                route,
                stream: responses.some(
                    (response) =>
                        isRecord(response) &&
                        response.content?.["text/event-stream"] !== undefined
                ),
                summary:
                    typeof operation.summary === "string"
                        ? operation.summary
                        : "",
            });
        }
    }
    return found;
};
