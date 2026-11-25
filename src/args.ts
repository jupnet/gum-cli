import { GumError } from "./api";
import type { Input } from "./model";
import { type AnyCommand, closest, isMeta, type Node, ROOT } from "./tree";

// Leading words pick the command (`swaps create`, `buy`); everything after
// is that command's positional arguments and flags. Flags are strict: one
// the command doesn't take, a repeated one or a switch given a value stops
// before anything is quoted or signed, so a mistyped --dry-run never runs as
// a real trade.

export type Global = {
    compact: boolean;
    help: boolean;
    network?: string;
    pretty: boolean;
    profile?: string;
    version: boolean;
};

export type Flags = Record<string, string | boolean>;

export type Line =
    | {
          command: AnyCommand;
          flags: Flags;
          global: Global;
          kind: "command";
          positionals: string[];
      }
    | { global: Global; kind: "group"; node: Node; unknown?: string };

const GLOBAL_SWITCHES = new Set(["compact", "help", "pretty", "version"]);
const GLOBAL_VALUES = new Set(["network", "profile"]);
const SHORT: Record<string, string> = { "-h": "help", "-y": "yes" };

const invalid = (message: string) => new GumError("invalid_request", message);

type FlagToken = { name: string; value?: string };

const flagToken = (token: string): FlagToken | null => {
    // Own keys only: "constructor" or "toString" is a word, not a flag.
    const short = Object.hasOwn(SHORT, token) ? SHORT[token] : undefined;
    if (short) {
        return { name: short };
    }
    if (!token.startsWith("--") || token === "--") {
        return null;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    return equals >= 0
        ? { name: body.slice(0, equals), value: body.slice(equals + 1) }
        : { name: body };
};

const switchValue = (name: string, value: string | undefined) => {
    if (value === undefined || value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw invalid(
        `--${name} is a switch: use --${name}, --${name}=true or --${name}=false.`
    );
};

const emptyGlobal = (): Global => ({
    compact: false,
    help: false,
    pretty: false,
    version: false,
});

class Reader {
    private index = 0;
    private readonly argv: string[];
    private readonly seen = new Set<string>();
    readonly global = emptyGlobal();

    constructor(argv: string[]) {
        this.argv = argv;
    }

    peek() {
        return this.argv[this.index];
    }

    next() {
        const token = this.argv[this.index];
        this.index += 1;
        return token;
    }

    rest() {
        return this.argv.slice(this.index);
    }

    /** Records a flag once; a second --x is an error, not a silent override. */
    mark(name: string) {
        if (this.seen.has(name)) {
            throw invalid(`--${name} is given twice.`);
        }
        this.seen.add(name);
    }

    /** A value for --name: after `=`, else the next word. */
    valueFor(name: string, token: FlagToken) {
        if (token.value !== undefined) {
            return token.value;
        }
        const next = this.peek();
        if (next === undefined || next.startsWith("--")) {
            throw invalid(`--${name} needs a value.`);
        }
        this.next();
        return next;
    }

    /** Reads a global flag; false when the token is some other flag. */
    readGlobal(token: FlagToken) {
        if (GLOBAL_SWITCHES.has(token.name)) {
            this.mark(token.name);
            this.global[
                token.name as "compact" | "help" | "pretty" | "version"
            ] = switchValue(token.name, token.value);
            return true;
        }
        if (GLOBAL_VALUES.has(token.name)) {
            this.mark(token.name);
            const value = this.valueFor(token.name, token);
            if (value.trim() === "") {
                throw invalid(`--${token.name} needs a value.`);
            }
            this.global[token.name as "network" | "profile"] = value;
            return true;
        }
        return false;
    }
}

const unknownFlag = (command: AnyCommand, name: string) => {
    const accepted = command.inputs.map((input) => input.flag);
    const meant = closest(name, accepted);
    const takes =
        accepted.length > 0
            ? `It takes ${accepted.map((flag) => `--${flag}`).join(", ")}.`
            : "It takes no flags.";
    return invalid(
        meant
            ? `${command.path.join(" ")} has no --${name}. Did you mean --${meant}?`
            : `${command.path.join(" ")} has no --${name}. ${takes}`
    );
};

const readCommand = (reader: Reader, command: AnyCommand): Line => {
    const byFlag = new Map<string, Input>(
        command.inputs.map((input) => [input.flag, input])
    );
    const anyFlags = isMeta(command) && command.anyFlags === true;
    const flags: Flags = {};
    const positionals: string[] = [];
    for (
        let token = reader.next();
        token !== undefined;
        token = reader.next()
    ) {
        if (token === "--") {
            positionals.push(...reader.rest());
            break;
        }
        const parsed = flagToken(token);
        if (!parsed) {
            positionals.push(token);
            continue;
        }
        if (reader.readGlobal(parsed)) {
            continue;
        }
        const input = byFlag.get(parsed.name);
        if (!input) {
            if (!anyFlags) {
                throw unknownFlag(command, parsed.name);
            }
            reader.mark(parsed.name);
            const next = reader.peek();
            flags[parsed.name] =
                parsed.value ??
                (next !== undefined && !next.startsWith("--")
                    ? (reader.next() ?? true)
                    : true);
            continue;
        }
        reader.mark(parsed.name);
        flags[parsed.name] =
            input.type === "boolean"
                ? switchValue(parsed.name, parsed.value)
                : reader.valueFor(parsed.name, parsed);
    }
    return {
        command,
        flags,
        global: reader.global,
        kind: "command",
        positionals,
    };
};

const isGlobal = (name: string) =>
    GLOBAL_SWITCHES.has(name) || GLOBAL_VALUES.has(name);

/** Splits argv into the command it names, that command's arguments and flags, and the global flags. */
export const parseLine = (argv: string[]): Line => {
    const reader = new Reader(argv);
    let node = ROOT;
    for (
        let token = reader.peek();
        token !== undefined;
        token = reader.peek()
    ) {
        const parsed = flagToken(token);
        if (parsed) {
            if (!isGlobal(parsed.name)) {
                break;
            }
            reader.next();
            reader.readGlobal(parsed);
            continue;
        }
        const child = node.children.get(token);
        if (!child) {
            break;
        }
        reader.next();
        node = child;
        if (node.command && node.children.size === 0) {
            return readCommand(reader, node.command);
        }
    }
    if (node.command) {
        return readCommand(reader, node.command);
    }
    const unknown = reader.peek();
    return {
        global: reader.global,
        kind: "group",
        node,
        ...(unknown === undefined ? {} : { unknown }),
    };
};
