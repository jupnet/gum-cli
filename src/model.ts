// What codegen/build.ts derives from an API's OpenAPI snapshot and its
// annotations (apis/<api>/). The CLI, its help, search, schema and MCP server
// all run from that output, src/generated/<api>.json.

export type Scalar = boolean | number | string;

/**
 * How the CLI fills a field itself: `wallet` with the signing wallet's
 * address; `token` turns a symbol into its address and fills a missing
 * chainId; `token-or-usd` does the same but passes "USD" through and never
 * picks the chain.
 */
export type Resolver = "token" | "token-or-usd" | "wallet";

export type InputType =
    | "array"
    | "boolean"
    | "integer"
    | "number"
    | "object"
    | "string";

/** One value a command takes: an API field, or (in: "cli") one of the CLI's own. */
export type Input = {
    description: string;
    enum?: string[];
    /** The API's name for it; for `in: "cli"`, the CLI's. */
    field: string;
    /** The --flag it is set with. */
    flag: string;
    in: "body" | "cli" | "path" | "query";
    maximum?: number;
    minimum?: number;
    /** Its index among the command's positional arguments. */
    position?: number;
    required: boolean;
    resolve?: Resolver;
    type: InputType;
    /** A positional that takes every remaining word. */
    variadic?: boolean;
};

export type Endpoint = {
    method: "GET" | "POST";
    operationId: string;
    route: string;
};

export type SynchronousSubmissionExpectation = {
    final?: boolean;
    statuses: string[];
    type: string;
};

export type Run =
    | {
          kind: "request";
          readOnly: boolean;
          wait?: { timeoutSeconds: number; until: string };
      }
    | { cursor: string; items: string; kind: "paginate"; next: string }
    | { fallback?: Endpoint; kind: "stream"; until?: string }
    | {
          /** Expected fields on synchronous submissions without a polling status endpoint. */
          expect?: SynchronousSubmissionExpectation;
          kind: "signed";
          /** CLI command to inspect account state when a submission outcome is uncertain. */
          recovery?: string;
          status?: Endpoint;
          submit: Endpoint;
          /** The quote field holding the USD value checked against the limit. */
          usd: string;
          waitSeconds?: number;
      };

export type McpTool = {
    description: string;
    name: string;
    /** Fields the tool leaves to the server, e.g. the wallet's address. */
    omit: string[];
    /** Signed tools: how long to wait for a final status; 0 returns once submitted. */
    waitSeconds?: number;
};

export type Command = {
    examples: string[];
    /** Fields always sent as given, e.g. a shortcut's { side: "buy" }. */
    fixed: Record<string, Scalar>;
    /** Fields the CLI fills and never takes, e.g. the signer's address. */
    hidden: Record<string, Resolver>;
    inputs: Input[];
    keywords: string[];
    mcp?: McpTool;
    method: "GET" | "POST";
    operationId: string;
    /** The words after `gumag`: ["swaps", "create"], or ["buy"] for a shortcut. */
    path: string[];
    route: string;
    run: Run;
    /** For a shortcut, the command it stands for, e.g. "swaps create". */
    shortcutOf?: string;
    summary: string;
    usage: string;
};

export type Operation = {
    description: string;
    /** Why the CLI won't call it directly, e.g. a submit only a signed command may make. */
    exclude?: string;
    inputs: Input[];
    method: "GET" | "POST";
    operationId: string;
    route: string;
    stream: boolean;
    summary: string;
};

export type GeneratedApi = {
    api: string;
    commands: Command[];
    operations: Operation[];
    server: string;
    specSha256: string;
    title: string;
    version: string;
};
