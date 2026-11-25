import { GumError } from "./api";
import trading from "./generated/trading-api.json" with { type: "json" };
import type { Command, GeneratedApi, Input, Operation } from "./model";

/** The Trading API's generated commands and operations. */
export const TRADING_API = trading as unknown as GeneratedApi;

/** What help, search, schema and completion know about any command. */
export type Described = {
    examples: string[];
    inputs: Input[];
    keywords: string[];
    path: string[];
    shortcutOf?: string;
    summary: string;
    usage: string;
};

/** A command the CLI implements itself rather than calling one operation. */
export type MetaCommand = Described & {
    /** `api` passes flags it doesn't know on to the operation. */
    anyFlags?: boolean;
    meta: true;
    /** Trading workflow commands appear alongside API commands in root help. */
    trading?: true;
};

export type AnyCommand = Command | MetaCommand;

export const isMeta = (command: AnyCommand): command is MetaCommand =>
    "meta" in command;

const DASHED = /-([a-z])/g;

const flag = (
    name: string,
    type: Input["type"],
    description: string,
    extra: Partial<Input> = {}
): Input => ({
    description,
    field: name.replace(DASHED, (_, letter: string) => letter.toUpperCase()),
    flag: name,
    in: "cli",
    required: false,
    type,
    ...extra,
});

const positional = (
    name: string,
    description: string,
    extra: Partial<Input> = {}
): Input => flag(name, "string", description, { position: 0, ...extra });

const meta = (
    path: string[],
    summary: string,
    usage: string,
    keywords: string[],
    inputs: Input[] = [],
    extra: Partial<MetaCommand> = {}
): MetaCommand => ({
    examples: [],
    inputs,
    keywords,
    meta: true,
    path,
    summary,
    usage,
    ...extra,
});

const query = positional("query", "What you want to do, in plain words.", {
    required: true,
    variadic: true,
});

export const META_COMMANDS: MetaCommand[] = [
    meta(
        ["auth", "login"],
        "Create a bot wallet for this profile (Solana, or EVM with --evm), or --import an existing key from stdin or a hidden prompt.",
        "gumag auth login [--evm] [--import] [--max-usd <usd>] [--profile <name>] [--network mainnet|devnet]",
        ["wallet key create new account setup generate bot sign in import"],
        [
            flag(
                "evm",
                "boolean",
                "Create an EVM key instead of a Solana one."
            ),
            flag(
                "import",
                "boolean",
                "Import a key instead: read from stdin, or asked for without echo on a terminal."
            ),
            flag(
                "max-usd",
                "number",
                "This profile's USD limit: no trade or withdrawal above it."
            ),
        ],
        {
            examples: [
                "gumag auth login",
                "gumag auth login --profile devbot --network devnet --max-usd 25",
                "gumag auth login --import < key.txt",
            ],
        }
    ),
    meta(
        ["auth", "status"],
        "The profile in use: its wallet address, where the key comes from, network and USD limit.",
        "gumag auth status",
        ["whoami address account wallet profile which"]
    ),
    meta(
        ["auth", "logout"],
        "Stop using this profile's key. It moves to keys/archive, never deleted, since its wallet may hold funds.",
        "gumag auth logout [--profile <name>]",
        ["sign out remove forget key"]
    ),
    meta(
        ["auth", "use"],
        "Make a profile the one commands use by default.",
        "gumag auth use <profile>",
        ["switch profile select default"],
        [positional("profile", "The profile's name.", { required: true })]
    ),
    meta(
        ["whoami"],
        "The wallet this CLI signs with, and where its key comes from (same as auth status).",
        "gumag whoami",
        ["address account me wallet who"]
    ),
    meta(
        ["cli", "search"],
        "Find the command for a task, in plain words.",
        'gumag cli search "<what you want to do>"',
        ["find help discover which command how"],
        [query],
        { examples: ['gumag cli search "withdraw usdc to base"'] }
    ),
    meta(
        ["search"],
        "Find the command for a task, in plain words (same as cli search).",
        'gumag search "<what you want to do>"',
        ["find help discover which command how"],
        [query]
    ),
    meta(
        ["cli", "agents-md"],
        "A block to add to a project's AGENTS.md, so coding agents there know how to use gumag.",
        "gumag cli agents-md",
        ["agents claude codex cursor instructions context project"]
    ),
    meta(
        ["schema"],
        "A command's arguments and flags with their types, as JSON.",
        "gumag schema <command...>",
        ["inputs parameters flags arguments types json schema"],
        [
            positional("command", "The command's words, e.g. swaps create.", {
                variadic: true,
            }),
        ],
        { examples: ["gumag schema swaps create"] }
    ),
    meta(
        ["api"],
        "Call an API operation by its operationId, including ones newer than this CLI.",
        "gumag api <operationId> [--<param> <value>…] [--body <json|@file|@->] [--dry-run]",
        ["raw endpoint request openapi http call operation"],
        [
            positional("operationId", "From `gumag cli search` or the spec.", {
                required: true,
            }),
            flag(
                "body",
                "string",
                "The JSON body, inline, from a file (@path) or from stdin (@-)."
            ),
            flag(
                "dry-run",
                "boolean",
                "Print the request instead of sending it."
            ),
        ],
        { anyFlags: true, examples: ["gumag api listChains"] }
    ),
    meta(
        ["mcp"],
        "Serve MCP over stdio for Claude, Codex, Cursor and other agents.",
        "gumag mcp",
        ["agent claude codex cursor tools server model context protocol"]
    ),
    meta(
        ["completion"],
        "A shell completion script: gumag completion zsh >> ~/.zshrc",
        "gumag completion bash|zsh|fish",
        ["shell tab complete bash zsh fish"],
        [
            positional("shell", "Your shell.", {
                enum: ["bash", "zsh", "fish"],
                required: true,
            }),
        ]
    ),
    meta(
        ["help"],
        "What a command does and takes.",
        "gumag help [command...]",
        ["usage manual"],
        [positional("command", "The command's words.", { variadic: true })]
    ),
    meta(
        ["perps", "positions"],
        "Open GUM Perps positions across sub-accounts, yours unless you pass an address.",
        "gumag perps positions [address] [--symbol <symbol>] [--subaccount-id <subaccount-id>]",
        ["perps open positions pnl liquidation margin exposure long short"],
        [
            positional("address", "Account address. Defaults to your wallet."),
            flag(
                "symbol",
                "string",
                "Filter to one Perps market symbol, e.g. SOL."
            ),
            flag(
                "subaccount-id",
                "integer",
                "Filter to one sub-account index (0–4).",
                { maximum: 4, minimum: 0 }
            ),
        ],
        {
            examples: [
                "gumag perps positions",
                "gumag perps positions --symbol SOL",
            ],
            trading: true,
        }
    ),
    meta(
        ["perps", "orders", "list"],
        "Open resting GUM Perps orders across sub-accounts, yours unless you pass an address.",
        "gumag perps orders list [address] [--symbol <symbol>] [--subaccount-id <subaccount-id>]",
        ["perps open resting limit orders book"],
        [
            positional("address", "Account address. Defaults to your wallet."),
            flag(
                "symbol",
                "string",
                "Filter to one Perps market symbol, e.g. SOL."
            ),
            flag(
                "subaccount-id",
                "integer",
                "Filter to one sub-account index (0–4).",
                { maximum: 4, minimum: 0 }
            ),
        ],
        {
            examples: [
                "gumag perps orders list",
                "gumag perps orders list --symbol SOL",
            ],
            trading: true,
        }
    ),
    meta(
        ["perps", "close"],
        "Close all or part of an open GUM Perps position with a reduce-only market order.",
        "gumag perps close <symbol> [size] [--margin-mode cross|isolated] [--subaccount-id <subaccount-id>] [--slippage <bps>] [--dry-run] [--yes] [--max-usd <usd>]",
        ["perps close exit flatten unwind reduce position market"],
        [
            positional("symbol", "Market symbol to close, e.g. SOL.", {
                required: true,
            }),
            positional(
                "size",
                "Optional base-unit size to close. Omit to close the full open position.",
                { position: 1 }
            ),
            flag(
                "margin-mode",
                "string",
                "Disambiguate when both cross and isolated positions exist.",
                { enum: ["cross", "isolated"] }
            ),
            flag(
                "subaccount-id",
                "integer",
                "Sub-account index (0–4) when positions span multiple sub-accounts.",
                { maximum: 4, minimum: 0 }
            ),
            flag(
                "slippage",
                "integer",
                "Maximum slippage in basis points for the market close (0–400).",
                { field: "slippageBps", maximum: 400, minimum: 0 }
            ),
            flag(
                "dry-run",
                "boolean",
                "Quote and sign, then have the API check the signature without submitting. Nothing moves."
            ),
            flag(
                "yes",
                "boolean",
                "Don't ask before signing. Required when nobody is at the terminal: without it the command stops with the quote."
            ),
            flag(
                "max-usd",
                "number",
                "Refuse anything above this many dollars. The lowest of this, GUM_MAX_TRADE_USD and the profile's limit applies."
            ),
        ],
        {
            examples: [
                "gumag perps close SOL --dry-run --yes",
                "gumag perps close SOL 0.5 --yes",
                "gumag perps close SOL --margin-mode isolated --yes",
            ],
            trading: true,
        }
    ),
];

export const COMMANDS: AnyCommand[] = [
    ...TRADING_API.commands,
    ...META_COMMANDS,
];

export type Node = {
    children: Map<string, Node>;
    command?: AnyCommand;
    path: string[];
};

const buildTree = (commands: AnyCommand[]) => {
    const root: Node = { children: new Map(), path: [] };
    for (const command of commands) {
        let node = root;
        for (const word of command.path) {
            let child = node.children.get(word);
            if (!child) {
                child = { children: new Map(), path: [...node.path, word] };
                node.children.set(word, child);
            }
            node = child;
        }
        node.command = command;
    }
    return root;
};

export const ROOT = buildTree(COMMANDS);

export const findCommand = (words: string[]) => {
    let node: Node | undefined = ROOT;
    for (const word of words) {
        node = node?.children.get(word);
    }
    return node;
};

/** Every command under a node, in the order they were declared. */
export const commandsUnder = (node: Node): AnyCommand[] =>
    COMMANDS.filter((command) =>
        node.path.every((word, index) => command.path[index] === word)
    );

export const operationById = (operationId: string): Operation | undefined =>
    TRADING_API.operations.find(
        (operation) =>
            operation.operationId.toLowerCase() === operationId.toLowerCase()
    );

/** An operation's route, for the few calls the CLI makes on its own (token lookup). */
export const routeOf = (operationId: string) => {
    const operation = operationById(operationId);
    if (!operation) {
        throw new GumError(
            "internal_error",
            `The Trading API has no ${operationId}.`
        );
    }
    return operation.route;
};

const NOT_LETTERS = /[^a-z0-9]/g;
const squash = (text: string) => text.toLowerCase().replace(NOT_LETTERS, "");

const distance = (left: string, right: string) => {
    const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
        let diagonal = previous[0] ?? 0;
        previous[0] = i;
        for (let j = 1; j <= right.length; j += 1) {
            const above = previous[j] ?? 0;
            previous[j] = Math.min(
                above + 1,
                (previous[j - 1] ?? 0) + 1,
                diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
            );
            diagonal = above;
        }
    }
    return previous[right.length] ?? 0;
};

/** The candidate someone most likely meant: same letters, or one or two typos off. */
export const closest = (word: string, candidates: string[]) => {
    const target = squash(word);
    const same = candidates.find((candidate) => squash(candidate) === target);
    if (same) {
        return same;
    }
    let best: string | undefined;
    let bestDistance = 3;
    for (const candidate of candidates) {
        const found = distance(target, squash(candidate));
        if (found < bestDistance) {
            best = candidate;
            bestDistance = found;
        }
    }
    return best;
};
