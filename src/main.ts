import { detectAgent, type Env, isCi } from "./agent";
import { agentsMd } from "./agentsMd";
import { type Api, createApi, GumError, toErrorBody } from "./api";
import { type Line, parseLine } from "./args";
import { authLogin, authLogout, authStatus, authUse } from "./auth";
import { completionScript } from "./completion";
import type { Context } from "./context";
import {
    AGENT_DISCOVERY,
    commandHelp,
    groupHelp,
    rootHelp,
    VERSION,
} from "./help";
import { type Io, memoryIo, processIo } from "./io";
import { runMcpServer } from "./mcp";
import { formatJson, type OutputMode } from "./output";
import { callFromFlags } from "./passthrough";
import { perpsClose, perpsOpenOrders, perpsPositions } from "./perps";
import { resolveSettings } from "./profile";
import { runGenerated } from "./run";
import { collect } from "./run/values";
import { schemaOf } from "./schema";
import { search } from "./search";
import { COMMANDS, closest, findCommand, isMeta, TRADING_API } from "./tree";

export { VERSION } from "./help";

export type CliResult = {
    exitCode: number;
    /** JSON lines printed as they came: streams and --all. */
    lines: unknown[];
    /** The result, or the error body, as printed. */
    output: unknown;
};

type Deps = { api?: Api; env?: Env; io?: Io };

type GroupLine = Extract<Line, { kind: "group" }>;
type CommandLine = Extract<Line, { kind: "command" }>;

const unknownCommand = (line: GroupLine, agent: string | null) => {
    const words = [...line.node.children.keys()];
    const where = ["gumag", ...line.node.path].join(" ");
    const unknown = line.unknown ?? "";
    const meant = unknown.startsWith("-") ? undefined : closest(unknown, words);
    let message: string;
    if (unknown.startsWith("-")) {
        message = `${where} needs a command before ${unknown}: ${words.join(", ")}.`;
    } else if (meant) {
        message = `${where} has no ${unknown}. Did you mean \`${where} ${meant}\`?`;
    } else {
        message = `${where} has no ${unknown}. It has ${words.join(", ")}; or find one with \`gumag cli search <task>\`.`;
    }
    return new GumError(
        "unknown_command",
        message,
        agent ? { details: { agentCommandDiscovery: AGENT_DISCOVERY } } : {}
    );
};

/** Help, or a schema, for the words after `gumag help` / `gumag schema`. */
const describe = (
    words: unknown,
    agent: string | null,
    as: "help" | "schema"
) => {
    const path = typeof words === "string" ? words.split(" ") : [];
    if (path.length === 0) {
        return as === "help"
            ? rootHelp(agent)
            : {
                  commands: COMMANDS.map(
                      (command) => `gumag ${command.path.join(" ")}`
                  ),
              };
    }
    const node = findCommand(path);
    if (node?.command) {
        return as === "help"
            ? commandHelp(node.command)
            : schemaOf(node.command);
    }
    if (node) {
        return groupHelp(node, agent);
    }
    throw new GumError(
        "unknown_command",
        `No command gumag ${path.join(" ")}. Find one with \`gumag cli search <task>\`.`
    );
};

const execute = (line: CommandLine, context: Context): Promise<unknown> => {
    const { command } = line;
    const { options, values } = collect(command, line.positionals, line.flags);
    if (!isMeta(command)) {
        return runGenerated(command, context, values, options);
    }
    switch (command.path.join(" ")) {
        case "auth login":
            return authLogin(context, options, line.global.network);
        case "auth logout":
            return Promise.resolve(authLogout(context));
        case "auth use":
            return Promise.resolve(authUse(context, String(options.profile)));
        case "api":
            return callFromFlags(
                context,
                String(options.operationId),
                line.flags
            );
        case "cli agents-md":
            return Promise.resolve(agentsMd());
        case "cli search":
        case "search":
            return search(String(options.query), context);
        case "completion":
            return Promise.resolve(completionScript(String(options.shell)));
        case "help":
            return Promise.resolve(
                describe(options.command, context.agent, "help")
            );
        case "schema":
            return Promise.resolve(
                describe(options.command, context.agent, "schema")
            );
        case "mcp":
            throw new GumError(
                "invalid_request",
                "gumag mcp serves MCP over stdio; run it from an MCP client."
            );
        case "perps positions":
            return perpsPositions(context, options);
        case "perps orders list":
            return perpsOpenOrders(context, options);
        case "perps close":
            return perpsClose(context, options);
        case "auth status":
        case "whoami":
            return Promise.resolve(authStatus(context));
        default:
            throw new GumError(
                "internal_error",
                `No handler for ${command.path.join(" ")}.`
            );
    }
};

const contextFor = (
    line: Line,
    env: Env,
    io: Io,
    agent: string | null,
    deps: Deps,
    lines: unknown[]
): Context => {
    const settings = resolveSettings(env, {
        ...(line.global.network === undefined
            ? {}
            : { network: line.global.network }),
        ...(line.global.profile === undefined
            ? {}
            : { profile: line.global.profile }),
    });
    const caller = agent ?? (io.stdoutTerminal ? "tty" : "pipe");
    return {
        agent,
        api:
            deps.api ??
            createApi(settings.apiUrl, fetch, {
                userAgent: `gumag/${VERSION} (${caller})`,
            }),
        emit: (value) => {
            lines.push(value);
            io.stdout(`${JSON.stringify(value)}\n`);
        },
        env,
        interactive: io.terminal && agent === null && !isCi(env),
        io,
        settings,
    };
};

/** Runs one command line and prints its result, so tests can call it directly. */
export const runCommand = async (
    argv: string[],
    deps: Deps = {}
): Promise<CliResult> => {
    const env = deps.env ?? process.env;
    const io = deps.io ?? memoryIo();
    const agent = detectAgent(env);
    const lines: unknown[] = [];
    let mode: OutputMode = io.stdoutTerminal && !agent ? "pretty" : "compact";
    const done = (output: unknown): CliResult => {
        if (typeof output === "string") {
            io.stdout(output);
        } else if (output !== undefined) {
            io.stdout(`${formatJson(output, mode, io.colors)}\n`);
        }
        return { exitCode: 0, lines, output };
    };
    try {
        const line = parseLine(argv);
        if (line.global.compact) {
            mode = "compact";
        } else if (line.global.pretty) {
            mode = "pretty";
        }
        if (line.global.version) {
            return done({
                api: `${TRADING_API.title} ${TRADING_API.version}`,
                version: VERSION,
            });
        }
        if (line.kind === "group") {
            if (line.unknown !== undefined && !line.global.help) {
                throw unknownCommand(line, agent);
            }
            return done(
                line.node.path.length === 0
                    ? rootHelp(agent)
                    : groupHelp(line.node, agent)
            );
        }
        if (line.global.help) {
            return done(commandHelp(line.command));
        }
        const context = contextFor(line, env, io, agent, deps, lines);
        return done(await execute(line, context));
    } catch (error) {
        const output = toErrorBody(error);
        io.stderr(`${formatJson(output, mode)}\n`);
        return { exitCode: 1, lines, output };
    }
};

/** True when argv asks for the MCP server, rather than its help or version. */
export const servesMcp = (argv: string[]) => {
    try {
        const line = parseLine(argv);
        return (
            line.kind === "command" &&
            isMeta(line.command) &&
            line.command.path.join(" ") === "mcp" &&
            !line.global.help &&
            !line.global.version &&
            line.positionals.length === 0
        );
    } catch {
        return false;
    }
};

export const main = async (argv: string[]) => {
    const { env } = process;
    if (servesMcp(argv)) {
        // stdout carries the protocol; anything else goes to stderr.
        const io = {
            ...processIo(env),
            stdout: (text: string) => process.stderr.write(text),
        };
        try {
            const line = parseLine(argv);
            const context = {
                ...contextFor(line, env, io, "mcp", {}, []),
                emit: () => undefined,
                interactive: false,
            };
            await runMcpServer(context, VERSION);
        } catch (error) {
            process.stderr.write(`${JSON.stringify(toErrorBody(error))}\n`);
            process.exitCode = 1;
        }
        return;
    }
    const { exitCode } = await runCommand(argv, { env, io: processIo(env) });
    process.exitCode = exitCode;
};
