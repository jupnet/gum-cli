import { GumError } from "./api";
import type { Input } from "./model";

// One set of checks for a value, however it arrives: a command-line word or
// an MCP argument. Amounts stay the exact decimal strings the API takes.

const invalid = (message: string) => new GumError("invalid_request", message);

const invalidInteger = (input: Input, name: string) =>
    invalid(
        `${name} must be a whole number.${input.field === "chainId" ? " Use a numeric chain ID from `gumag chains list`." : ""}`
    );

const checked = <T>(input: Input, value: T, name: string): T => {
    if (input.enum && !input.enum.includes(String(value))) {
        throw invalid(
            `${name} must be ${input.enum.map((item) => `"${item}"`).join(" or ")}.`
        );
    }
    if (typeof value === "number") {
        if (input.minimum !== undefined && value < input.minimum) {
            throw invalid(`${name} must be at least ${input.minimum}.`);
        }
        if (input.maximum !== undefined && value > input.maximum) {
            throw invalid(`${name} must be at most ${input.maximum}.`);
        }
    }
    return value;
};

/** A command-line value as its input's type. */
export const fromText = (
    input: Input,
    raw: string | boolean,
    name: string
): unknown => {
    if (input.type === "boolean") {
        if (typeof raw === "boolean") {
            return raw;
        }
        if (raw === "true" || raw === "false") {
            return raw === "true";
        }
        throw invalid(
            `${name} is a switch: use ${name}, ${name}=true or ${name}=false.`
        );
    }
    if (typeof raw === "boolean" || raw.trim() === "") {
        throw invalid(`${name} needs a value.`);
    }
    switch (input.type) {
        case "integer": {
            const value = Number(raw);
            if (!Number.isInteger(value)) {
                throw invalidInteger(input, name);
            }
            return checked(input, value, name);
        }
        case "number": {
            const value = Number(raw);
            if (!Number.isFinite(value)) {
                throw invalid(`${name} must be a number.`);
            }
            return checked(input, value, name);
        }
        case "array":
        case "object":
            try {
                return JSON.parse(raw);
            } catch (error) {
                throw new GumError("invalid_request", `${name} must be JSON.`, {
                    cause: error,
                });
            }
        default:
            return checked(input, raw, name);
    }
};

/** An MCP argument, which arrives as JSON, checked against its input. */
export const fromJson = (
    input: Input,
    value: unknown,
    name: string
): unknown => {
    switch (input.type) {
        case "boolean":
            if (typeof value !== "boolean") {
                throw invalid(`${name} must be true or false.`);
            }
            return value;
        case "integer":
            if (typeof value !== "number" || !Number.isInteger(value)) {
                throw invalidInteger(input, name);
            }
            return checked(input, value, name);
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw invalid(`${name} must be a number.`);
            }
            return checked(input, value, name);
        case "array":
            if (!Array.isArray(value)) {
                throw invalid(`${name} must be an array.`);
            }
            return value;
        case "object":
            if (
                typeof value !== "object" ||
                value === null ||
                Array.isArray(value)
            ) {
                throw invalid(`${name} must be an object.`);
            }
            return value;
        default:
            if (typeof value !== "string") {
                throw invalid(`${name} must be a string.`);
            }
            if (value.trim() === "") {
                throw invalid(`${name} needs a value.`);
            }
            return checked(input, value, name);
    }
};

/** A JSON Schema for MCP clients: these inputs, by field name, nothing else. */
export const jsonSchemaOf = (inputs: Input[]) => ({
    additionalProperties: false,
    properties: Object.fromEntries(
        inputs.map((input) => [
            input.field,
            {
                ...(input.description
                    ? { description: input.description }
                    : {}),
                ...(input.enum ? { enum: input.enum } : {}),
                ...(input.maximum === undefined
                    ? {}
                    : { maximum: input.maximum }),
                ...(input.minimum === undefined
                    ? {}
                    : { minimum: input.minimum }),
                type: input.type,
            },
        ])
    ),
    required: inputs
        .filter((input) => input.required)
        .map((input) => input.field),
    type: "object",
});
