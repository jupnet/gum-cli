import { createInterface } from "node:readline";
import { GumError, toErrorBody } from "./api";
import { authStatus } from "./auth";
import type { Context } from "./context";
import { liveOnlyOperations } from "./live";
import type { Command, Input, Operation } from "./model";
import { callFromJson } from "./passthrough";
import { perpsClose } from "./perps";
import { limitOf } from "./profile";
import { runGenerated } from "./run";
import type { Options, Values } from "./run/values";
import { rank } from "./search";
import { TRADING_API } from "./tree";
import { fromJson, jsonSchemaOf } from "./validate";

// The MCP tools surface over stdio: initialize, tools/list, tools/call and
// ping, as newline-delimited JSON-RPC (modelcontextprotocol.io). The tools
// come from the same generated commands as the CLI, so they can't drift from
// it. Small enough to own, which keeps `npx @gumag/cli mcp` quick to start.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BATCH = 20;

const INSTRUCTIONS =
    "GUM spot and perpetual futures trading with the wallet this server holds. Call whoami first. Amounts are decimal strings: USD for spot buys, tokens for spot sells, and base units (or USD with sizeCurrency='USD') for GUM Perps. Use list_perps_markets, get_perps_orderbook, get_perps_funding_history and get_perps_account to inspect perpetual markets and positions. Signed write tools (trade, withdraw, perps_place_order, perps_close_position, perps_cancel_order, perps_deposit, perps_withdraw, perps_set_leverage) move real funds or orders: they need a USD limit on the server (GUM_MAX_TRADE_USD or the profile's), including dryRun which signs and verifies without executing. Use quote tools for unsigned quotes. search_api and call_api reach any other read-only endpoint, including ones newer than this server.";

type ToolAnnotations = {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
};

export type Tool = {
    annotations: ToolAnnotations;
    description: string;
    inputs: Input[];
    name: string;
    run: (values: Values) => Promise<unknown>;
    signed?: boolean;
};

const input = (
    field: string,
    type: Input["type"],
    description: string,
    required = false
): Input => ({
    description,
    field,
    flag: field,
    in: "cli",
    required,
    type,
});

/** Checks MCP arguments against a tool's inputs: unknown fields are refused, not ignored. */
export const argumentsOf = (tool: Tool, args: unknown): Values => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new GumError("invalid_request", "Arguments must be an object.");
    }
    const values = Object.create(null) as Values;
    for (const [name, value] of Object.entries(args)) {
        const known = tool.inputs.find((candidate) => candidate.field === name);
        if (!known) {
            throw new GumError(
                "invalid_request",
                `${tool.name} has no ${name}. It takes ${tool.inputs.map((candidate) => candidate.field).join(", ") || "nothing"}.`
            );
        }
        if (value !== undefined) {
            values[name] = fromJson(known, value, name);
        }
    }
    const missing = tool.inputs.filter(
        (candidate) =>
            candidate.required &&
            (!Object.hasOwn(values, candidate.field) ||
                values[candidate.field] === undefined)
    );
    if (missing.length > 0) {
        throw new GumError(
            "invalid_request",
            `${tool.name} needs ${missing.map((candidate) => candidate.field).join(", ")}.`
        );
    }
    return values;
};

const DRY_RUN = input(
    "dryRun",
    "boolean",
    "Quote and sign, then have the API check the signature without submitting. Nothing moves."
);

const generatedTool = (command: Command, context: Context): Tool | null => {
    const { mcp } = command;
    if (!mcp) {
        return null;
    }
    const signed = command.run.kind === "signed";
    const inputs = [
        ...command.inputs.filter(
            (candidate) =>
                candidate.in !== "cli" && !mcp.omit.includes(candidate.field)
        ),
        ...(signed ? [DRY_RUN] : []),
    ];
    const readOnly =
        command.run.kind === "paginate" ||
        (command.run.kind === "request" && command.run.readOnly);
    return {
        annotations: signed
            ? { destructiveHint: true, openWorldHint: true }
            : readOnly
              ? { readOnlyHint: true }
              : { openWorldHint: true },
        description: mcp.description,
        inputs,
        name: mcp.name,
        run: (values) => {
            const { dryRun, ...fields } = values;
            const options: Options = signed
                ? {
                      dryRun: dryRun === true,
                      noWait: mcp.waitSeconds === 0,
                      requireLimit: true,
                      timeout: mcp.waitSeconds,
                      yes: true,
                  }
                : {};
            return runGenerated(command, context, fields, options);
        },
        ...(signed ? { signed: true } : {}),
    };
};

const mcpWhoami = (context: Context) => {
    let status: ReturnType<typeof authStatus>;
    try {
        status = authStatus(context);
    } catch (error) {
        if (error instanceof GumError && error.code === "no_wallet") {
            throw new GumError(error.code, error.message);
        }
        throw error;
    }
    const source =
        status.source === "GUM_SOLANA_SECRET_KEY" ||
        status.source === "GUM_EVM_PRIVATE_KEY"
            ? status.source
            : "profile_key";
    const effectiveLimit = limitOf(undefined, context.env, context.settings);
    return {
        address: status.address,
        apiUrl: status.apiUrl,
        kind: status.kind,
        maxTradeUsd: effectiveLimit ?? null,
        network: status.network,
        profile: status.profile,
        source,
    };
};

const describeOperation = (operation: Operation) => ({
    description: operation.description || undefined,
    method: operation.method,
    operationId: operation.operationId,
    parameters: operation.inputs.map((candidate) => ({
        description: candidate.description || undefined,
        in: candidate.in,
        name: candidate.field,
        required: candidate.required,
        type: candidate.type,
    })),
    path: operation.route,
    summary: operation.summary,
});

export const createTools = (context: Context): Tool[] => [
    {
        annotations: { readOnlyHint: true },
        description:
            "The wallet this server trades with: its address, Solana or EVM, the profile and its USD limit. Call this first; the other tools default to this wallet.",
        inputs: [],
        name: "whoami",
        run: () => Promise.resolve(mcpWhoami(context)),
    },
    ...TRADING_API.commands.flatMap((command) => {
        const tool = generatedTool(command, context);
        return tool ? [tool] : [];
    }),
    {
        annotations: { destructiveHint: true, openWorldHint: true },
        description:
            "Close all or part of an open GUM Perps position with a reduce-only market order. Omit size to close the full position; specify marginMode and/or subaccountId if multiple positions exist for the same market. Set dryRun to verify without executing. Needs a USD limit.",
        inputs: [
            input(
                "symbol",
                "string",
                "Market symbol to close, e.g. SOL.",
                true
            ),
            input(
                "size",
                "string",
                "Optional base-unit size to close. Omit to close the full open position."
            ),
            {
                ...input(
                    "marginMode",
                    "string",
                    "Margin mode to disambiguate when both cross and isolated positions exist."
                ),
                enum: ["cross", "isolated"],
            },
            {
                ...input(
                    "subaccountId",
                    "integer",
                    "Sub-account index (0–4) when positions span multiple sub-accounts."
                ),
                maximum: 4,
                minimum: 0,
            },
            {
                ...input(
                    "slippageBps",
                    "integer",
                    "Maximum slippage in basis points for the market close (0–400)."
                ),
                maximum: 400,
                minimum: 0,
            },
            DRY_RUN,
        ],
        name: "perps_close_position",
        run: (values) =>
            perpsClose(context, values, {
                requireLimit: true,
                yes: true,
            }),
        signed: true,
    },
    {
        annotations: { readOnlyHint: true },
        description:
            'Search the API for an endpoint in plain words (e.g. "price history"). Returns each match\'s operationId and parameters, ready for call_api, including endpoints newer than this server.',
        inputs: [input("query", "string", "What you want to do.", true)],
        name: "search_api",
        run: async (values) => {
            let live: Operation[] = [];
            try {
                live = await liveOnlyOperations(context.api, context.env, {
                    timeoutMs: 3000,
                });
            } catch {
                live = [];
            }
            const operations = [...TRADING_API.operations, ...live].filter(
                (operation) => !(operation.exclude || operation.stream)
            );
            const ranked = rank(
                String(values.query),
                operations.map((operation) => ({
                    command: operation.operationId,
                    path: [operation.operationId.toLowerCase()],
                    summary: operation.summary,
                    text: [
                        operation.operationId,
                        operation.summary,
                        operation.description,
                        operation.route,
                    ].join(" "),
                }))
            );
            return {
                operations: ranked.flatMap((match) => {
                    const found = operations.find(
                        (operation) => operation.operationId === match.command
                    );
                    return found ? [describeOperation(found)] : [];
                }),
            };
        },
    },
    {
        annotations: { openWorldHint: true },
        description:
            "Call an endpoint by operationId (find it with search_api). params fill path and query parameters; an address parameter defaults to this server's wallet. body is the JSON body. Submitting trades and withdrawals isn't allowed here: use trade and withdraw, which sign.",
        inputs: [
            input("operationId", "string", "From search_api.", true),
            input("params", "object", "Path and query parameters by name."),
            input("body", "object", "The JSON body, for POST operations."),
        ],
        name: "call_api",
        run: (values) =>
            callFromJson(
                context,
                String(values.operationId),
                values.params as Record<string, unknown> | undefined,
                values.body as Record<string, unknown> | undefined
            ),
    },
];

const reply = (value: unknown) => ({
    content: [{ text: JSON.stringify(value, null, 2), type: "text" }],
});

type Request = {
    id?: number | string | null;
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
};

const result = (id: Request["id"], value: unknown) => ({
    id,
    jsonrpc: "2.0",
    result: value,
});

const failure = (id: Request["id"], code: number, message: string) => ({
    error: { code, message },
    id: id ?? null,
    jsonrpc: "2.0",
});

/** Answers one JSON-RPC message; null for notifications, which get no reply. */
export const createMcpHandler = (context: Context, version: string) => {
    const tools = createTools(context);
    let signingQueue: Promise<void> = Promise.resolve();
    const serializeSigned = <T>(work: () => Promise<T>): Promise<T> => {
        const next = signingQueue.then(work, work);
        signingQueue = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    };
    return async (message: Request) => {
        if (message.id === undefined || message.id === null) {
            return null;
        }
        const { id, method, params } = message;
        if (method === "initialize") {
            const requested = params?.protocolVersion;
            return result(id, {
                capabilities: { tools: {} },
                instructions: INSTRUCTIONS,
                protocolVersion:
                    typeof requested === "string" &&
                    PROTOCOL_VERSIONS.includes(requested)
                        ? requested
                        : PROTOCOL_VERSIONS[0],
                serverInfo: { name: "gum", version },
            });
        }
        if (method === "ping") {
            return result(id, {});
        }
        if (method === "tools/list") {
            return result(id, {
                tools: tools.map((tool) => ({
                    annotations: tool.annotations,
                    description: tool.description,
                    inputSchema: jsonSchemaOf(tool.inputs),
                    name: tool.name,
                })),
            });
        }
        if (method === "tools/call") {
            const tool = tools.find(
                (candidate) => candidate.name === params?.name
            );
            if (!tool) {
                return failure(
                    id,
                    -32_602,
                    `Unknown tool: ${String(params?.name)}`
                );
            }
            try {
                const values = argumentsOf(tool, params?.arguments ?? {});
                const output = tool.signed
                    ? await serializeSigned(() => tool.run(values))
                    : await tool.run(values);
                return result(id, reply(output));
            } catch (error) {
                return result(id, {
                    ...reply(toErrorBody(error)),
                    isError: true,
                });
            }
        }
        return failure(id, -32_601, `Method not found: ${String(method)}`);
    };
};

/** A JSON-RPC request or notification: an object with a method name. */
const isRequestObject = (value: unknown): value is Request => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const { id, method } = value as Record<string, unknown>;
    return (
        typeof method === "string" &&
        (id === undefined ||
            id === null ||
            typeof id === "number" ||
            typeof id === "string")
    );
};

/**
 * The reply to one line of stdin, or null when nothing should be sent. A
 * line that isn't JSON, or a message that isn't a request, gets a JSON-RPC
 * error; nothing a client sends can stop the server.
 */
export const respondToLine = async (
    handle: ReturnType<typeof createMcpHandler>,
    line: string
): Promise<unknown> => {
    let message: unknown;
    try {
        message = JSON.parse(line);
    } catch {
        return failure(null, -32_700, "Parse error");
    }
    const answer = async (item: unknown) => {
        if (!isRequestObject(item)) {
            return failure(null, -32_600, "Invalid Request");
        }
        try {
            return await handle(item);
        } catch (error) {
            return failure(
                item.id,
                -32_603,
                error instanceof Error ? error.message : "Internal error"
            );
        }
    };
    if (!Array.isArray(message)) {
        return answer(message);
    }
    if (message.length === 0) {
        return failure(null, -32_600, "Invalid Request");
    }
    if (message.length > MAX_BATCH) {
        return failure(
            null,
            -32_600,
            `Batch size exceeds maximum of ${MAX_BATCH}.`
        );
    }
    const answers = (await Promise.all(message.map(answer))).filter(
        (response) => response !== null
    );
    return answers.length > 0 ? answers : null;
};

/** Serves MCP on stdin/stdout until stdin closes and all in-flight calls finish. Nothing else may write to stdout. */
export const runMcpServer = (context: Context, version: string) => {
    const handle = createMcpHandler(context, version);
    const lines = createInterface({ input: process.stdin });
    const pending = new Set<Promise<void>>();
    lines.on("line", (line) => {
        if (!line.trim()) {
            return;
        }
        const task = respondToLine(handle, line)
            .then((response) => {
                if (response !== null) {
                    process.stdout.write(`${JSON.stringify(response)}\n`);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                pending.delete(task);
            });
        pending.add(task);
    });
    return new Promise<void>((resolve) => {
        lines.on("close", () => {
            Promise.allSettled([...pending]).then(() => resolve());
        });
    });
};
