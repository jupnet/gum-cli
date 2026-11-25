import type { Env } from "./agent";
import type { Api } from "./api";
import type { Io } from "./io";
import type { Settings } from "./profile";

/** What a command runs with. */
export type Context = {
    /** The coding agent running the CLI, if one was detected. */
    agent: string | null;
    api: Api;
    /** Prints one JSON line right away: streams and --all. */
    emit: (value: unknown) => void;
    env: Env;
    /** A person can answer a prompt: terminals, no agent, not CI. */
    interactive: boolean;
    io: Io;
    settings: Settings;
};
