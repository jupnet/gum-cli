import { z } from "zod";

// What apis/<api>/cli.ts may say about each operation in that API's spec.
// codegen/build.ts turns the spec plus these into the CLI's commands.

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Every command ends in one of these, so the grammar stays predictable. */
export const VERBS = [
    "cancel",
    "create",
    "deposit",
    "get",
    "list",
    "quote",
    "search",
    "set",
    "watch",
    "withdraw",
] as const;

export const RESOLVERS = ["token", "token-or-usd", "wallet"] as const;

const Resolver = z.enum(RESOLVERS);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const Param = z.strictObject({
    description: z.string().optional(),
    flag: z.string().regex(KEBAB).optional(),
    /** Never an input: a resolver fills it (the signer's address). */
    hidden: z.literal(true).optional(),
    position: z.number().int().min(0).optional(),
    resolve: Resolver.optional(),
    variadic: z.literal(true).optional(),
});

const Run = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("request"),
        /** POSTs that change nothing, like quotes. GETs always are. */
        readOnly: z.boolean().optional(),
        /** Adds --wait: poll until this response field is true. */
        wait: z
            .strictObject({
                timeoutSeconds: z.number().int().positive(),
                until: z.string(),
            })
            .optional(),
    }),
    z.strictObject({
        cursor: z.string(),
        items: z.string(),
        kind: z.literal("paginate"),
        next: z.string(),
    }),
    z.strictObject({
        /** Polled with this operation if the stream can't be opened. */
        fallback: z.string().optional(),
        kind: z.literal("stream"),
        /** Stop after a message with this field true. */
        until: z.string().optional(),
    }),
    z.strictObject({
        /** Expected shape for synchronous submissions that don't poll a status endpoint. */
        expect: z
            .strictObject({
                final: z.boolean().optional(),
                statuses: z.array(z.string().min(1)).min(1),
                type: z.string().min(1),
            })
            .optional(),
        kind: z.literal("signed"),
        /** CLI command to verify state when a submission outcome is uncertain. */
        recovery: z.string().optional(),
        status: z.string().optional(),
        submit: z.string(),
        usd: z.string(),
        waitSeconds: z.number().int().positive().optional(),
    }),
]);

const Shortcut = z.strictObject({
    /** Positional arguments, by field name, in order. */
    args: z.array(z.string()).min(1),
    examples: z.array(z.string()).optional(),
    fixed: z.record(z.string(), Scalar).optional(),
    keywords: z.array(z.string()).optional(),
    name: z.string().regex(KEBAB),
    /** How usage names an argument, e.g. { amount: "usd" }. */
    placeholders: z.record(z.string(), z.string()).optional(),
    summary: z.string(),
});

const Command = z.strictObject({
    examples: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    mcp: z
        .strictObject({
            description: z.string(),
            omit: z.array(z.string()).optional(),
            tool: z.string().regex(SNAKE),
            waitSeconds: z.number().int().min(0).optional(),
        })
        .optional(),
    params: z.record(z.string(), Param).optional(),
    /** [resource, verb], or [product, resource, verb]. */
    path: z.array(z.string().regex(KEBAB)).min(2).max(3),
    run: Run.optional(),
    shortcuts: z.array(Shortcut).optional(),
    summary: z.string().optional(),
});

export const ApiAnnotations = z.strictObject({
    api: z.string().regex(KEBAB),
    /** Flag names for fields, the same in every command of this API. */
    flags: z.record(z.string(), z.string().regex(KEBAB)).optional(),
    operations: z.record(
        z.string(),
        z.union([
            z.strictObject({ commands: z.array(Command).min(1) }),
            z.strictObject({ exclude: z.string().min(10) }),
        ])
    ),
    /** Resolvers for fields, in every command of this API. */
    resolve: z.record(z.string(), Resolver).optional(),
});

export type ApiAnnotations = z.infer<typeof ApiAnnotations>;
export type CommandAnnotation = z.infer<typeof Command>;

/** Typed helper for apis/<api>/cli.ts. */
export const defineAnnotations = (
    annotations: z.input<typeof ApiAnnotations>
) => annotations;
