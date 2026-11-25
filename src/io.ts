import { createInterface } from "node:readline/promises";

/** Where a command reads and writes; tests swap in memoryIo. */
export type Io = {
    /** Colors are allowed on stdout. */
    colors: boolean;
    confirm: (question: string) => Promise<boolean>;
    readStdin: () => Promise<string>;
    secret: (question: string) => Promise<string>;
    stderr: (text: string) => void;
    /** stdin and stderr are terminals, so someone can answer a prompt. */
    terminal: boolean;
    stdinTerminal: boolean;
    stdout: (text: string) => void;
    stdoutTerminal: boolean;
};

const YES = /^y(es)?$/i;

const readAll = async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
};

const confirmOnTerminal = async (question: string) => {
    const lines = createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    try {
        const answer = await lines.question(`${question} [y/N] `);
        return YES.test(answer.trim());
    } finally {
        lines.close();
    }
};

/** Reads a line without echoing it, for keys. */
const secretOnTerminal = (question: string) =>
    new Promise<string>((resolve, reject) => {
        const input = process.stdin;
        process.stderr.write(question);
        input.setRawMode(true);
        input.resume();
        let value = "";
        const done = (error?: Error) => {
            input.setRawMode(false);
            input.pause();
            input.off("data", onData);
            process.stderr.write("\n");
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        };
        const onData = (chunk: Buffer) => {
            for (const char of chunk.toString("utf8")) {
                if (char === "\r" || char === "\n") {
                    done();
                    return;
                }
                if (char === "\u0003") {
                    done(new Error("Cancelled"));
                    return;
                }
                if (char === "\u007f" || char === "\b") {
                    value = value.slice(0, -1);
                } else {
                    value += char;
                }
            }
        };
        input.on("data", onData);
    });

export const processIo = (env: Record<string, string | undefined>): Io => {
    const stdoutTerminal = process.stdout.isTTY === true;
    const stdinTerminal = process.stdin.isTTY === true;
    const colors =
        env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0"
            ? true
            : stdoutTerminal &&
              env.NO_COLOR === undefined &&
              process.stdout.hasColors?.() === true;
    return {
        colors,
        confirm: confirmOnTerminal,
        readStdin: readAll,
        secret: secretOnTerminal,
        stderr: (text) => {
            process.stderr.write(text);
        },
        stdinTerminal,
        stdout: (text) => {
            process.stdout.write(text);
        },
        stdoutTerminal,
        terminal: stdinTerminal && process.stderr.isTTY === true,
    };
};

export type MemoryIo = Io & { err: string[]; out: string[] };

/** An Io that records what is written; for tests. */
export const memoryIo = (
    options: Partial<
        Pick<Io, "confirm" | "secret" | "stdoutTerminal" | "terminal">
    > & { stdin?: string } = {}
): MemoryIo => {
    const out: string[] = [];
    const err: string[] = [];
    return {
        colors: false,
        confirm:
            options.confirm ??
            (() => Promise.reject(new Error("Unexpected prompt"))),
        err,
        out,
        readStdin: () => Promise.resolve(options.stdin ?? ""),
        secret:
            options.secret ??
            (() => Promise.reject(new Error("Unexpected prompt"))),
        stderr: (text) => {
            err.push(text);
        },
        stdinTerminal: options.terminal ?? false,
        stdout: (text) => {
            out.push(text);
        },
        stdoutTerminal: options.stdoutTerminal ?? false,
        terminal: options.terminal ?? false,
    };
};
