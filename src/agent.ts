export type Env = Record<string, string | undefined>;

// Environment variables coding agents set in the shells they run. Detection
// switches output to compact JSON, turns prompts off and adds discovery hints
// to help; GUMAG_AGENT=1 or 0 overrides it either way.
const AGENT_VARIABLES: [string, string][] = [
    ["AI_AGENT", "agent"],
    ["CLAUDECODE", "claude-code"],
    ["CLAUDE_CODE", "claude-code"],
    ["CURSOR_AGENT", "cursor"],
    ["GEMINI_CLI", "gemini-cli"],
    ["CODEX_SANDBOX", "codex"],
    ["CODEX_CI", "codex"],
    ["AUGMENT_AGENT", "augment"],
    ["OPENCODE_CLIENT", "opencode"],
];

const isSet = (value: string | undefined) =>
    value !== undefined && value !== "" && value !== "0" && value !== "false";

/** The coding agent running this command, or null for a person or a script. */
export const detectAgent = (env: Env): string | null => {
    const forced = env.GUMAG_AGENT;
    if (forced === "0" || forced === "false") {
        return null;
    }
    if (isSet(forced)) {
        return forced === "1" || forced === "true" ? "agent" : (forced ?? null);
    }
    for (const [name, agent] of AGENT_VARIABLES) {
        if (isSet(env[name])) {
            return agent;
        }
    }
    return null;
};

export const isCi = (env: Env) => isSet(env.CI);
