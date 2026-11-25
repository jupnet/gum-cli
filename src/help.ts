import pkg from "../package.json" with { type: "json" };
import { DEFAULT_API_URL, NETWORKS } from "./api";
import {
    type AnyCommand,
    COMMANDS,
    commandsUnder,
    isMeta,
    type Node,
    TRADING_API,
} from "./tree";

export const VERSION = pkg.version;
export const DOCS_URL = "https://docs.gum.ag/trading-api/cli";

/** What an agent reads instead of paging through --help. */
export const AGENT_DISCOVERY =
    'Find the command for a task with `gumag cli search "<task>"`, then read its arguments and flags with `gumag schema <command>`. Results are JSON on stdout; failures are {"error":{"code","message"}} on stderr with exit code 1. For quotes without signing, use `gumag swaps quote`, `gumag withdrawals quote` or `gumag perps orders quote`. Signing commands (buy, sell, long, short, withdraw, swaps create, withdrawals create, perps orders create, perps close, perps orders cancel, perps deposit, perps withdraw, perps leverage set) stop with confirmation_required and the quote unless you pass --yes or --dry-run. Review the quote before authorizing --yes. On signing commands, --dry-run still signs locally and sends the signature to the API for validation; it does not execute the trade or withdrawal.';

const line = (command: AnyCommand) => ({
    command: command.usage,
    summary: command.summary,
});

export const rootHelp = (agent: string | null) => ({
    name: "gumag",
    summary:
        "GUM from a terminal or an agent: spot tokens, stocks, GUM Perps, balances, deposits, history and withdrawals, signed locally with your own wallet.",
    usage: "gumag <command> [arguments] [--flags]",
    version: VERSION,
    ...(agent ? { agentCommandDiscovery: AGENT_DISCOVERY } : {}),
    cli: commandsUnder({ children: new Map(), path: [] })
        .filter((command) => isMeta(command) && !command.trading)
        .map(line),
    commands: COMMANDS.filter(
        (command) =>
            (!isMeta(command) && !command.shortcutOf) ||
            (isMeta(command) && command.trading)
    ).map(line),
    docs: DOCS_URL,
    environment: {
        GUM_API_URL: "Another API base URL, e.g. http://localhost:4000/v1.",
        GUM_EVM_PRIVATE_KEY: "Sign with this EVM key instead of the profile's.",
        GUM_MAX_TRADE_USD:
            "No trade or withdrawal above this many dollars; the lowest of this, --max-usd and the profile's limit applies.",
        GUM_PROFILE: "The profile to use when --profile isn't given.",
        GUM_SOLANA_SECRET_KEY:
            "Sign with this Solana key (base58, 64 bytes) instead of the profile's.",
        GUMAG_AGENT:
            "1 or 0: force agent mode (compact output, no prompts) on or off.",
        NO_COLOR: "No colors on a terminal.",
    },
    flags: {
        "--compact":
            "One-line JSON, the default when piped or run by an agent.",
        "--help, -h": "What a command does and takes.",
        "--network mainnet|devnet": `Which GUM to use (default: the profile's, else mainnet ${DEFAULT_API_URL}; devnet is ${NETWORKS.devnet}).`,
        "--pretty": "Indented JSON, the default on a terminal.",
        "--profile <name>": "Which saved wallet and settings to use.",
        "--version": "This CLI's version.",
    },
    output: "Results are JSON on stdout: indented on a terminal, one line otherwise; streams and --all print one JSON object per line. Failures are {error:{code,message,details}} on stderr, exit code 1.",
    tasks: TRADING_API.commands
        .filter((command) => command.shortcutOf)
        .map(line),
});

export const groupHelp = (node: Node, agent: string | null) => ({
    command: `gumag ${node.path.join(" ")}`,
    commands: commandsUnder(node).map(line),
    ...(agent ? { agentCommandDiscovery: AGENT_DISCOVERY } : {}),
});

export const commandHelp = (command: AnyCommand) => ({
    command: command.usage,
    summary: command.summary,
    ...(command.shortcutOf
        ? { shortcutOf: `gumag ${command.shortcutOf}` }
        : {}),
    arguments: command.inputs
        .filter((input) => input.position !== undefined)
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map((input) => ({
            argument: `<${input.field}>`,
            description: input.description,
            required: input.required,
        })),
    examples: command.examples,
    flags: command.inputs
        .filter((input) => input.position === undefined)
        .map((input) => ({
            description: input.description,
            flag: `--${input.flag}`,
            ...(input.enum ? { values: input.enum } : {}),
            required: input.required,
        })),
    schema: `gumag schema ${command.path.join(" ")}`,
});
