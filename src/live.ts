import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./agent";
import { type Api, GumError } from "./api";
import type { Operation } from "./model";
import { parseOperations, type Spec } from "./openapi";
import { TRADING_API } from "./tree";

// The live spec, for operations the API gained after this build: `gumag
// api`, `gumag cli search` and MCP's search_api/call_api read it. Cached in
// memory and, for https APIs, on disk for ten minutes; a stale copy beats
// none when the API can't be reached.

const FRESH_MS = 10 * 60 * 1000;
const NOT_WORD = /[^a-z0-9]+/gi;

type Entry = { at: number; spec: Spec };

const memory = new WeakMap<Api, Entry>();

export const cacheFileOf = (env: Env, baseUrl: string) =>
    join(
        env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "gumag",
        `${baseUrl.replace(NOT_WORD, "_").slice(0, 120)}.json`
    );

const readDisk = (path: string): Entry | null => {
    try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
        return typeof entry.at === "number" && typeof entry.spec === "object"
            ? entry
            : null;
    } catch {
        return null;
    }
};

const writeDisk = (path: string, entry: Entry) => {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(entry));
    } catch {
        // A cache that can't be written only costs a fetch next time.
    }
};

export const loadLiveSpec = async (
    api: Api,
    env: Env,
    { now = Date.now, timeoutMs = 5000 } = {}
): Promise<Spec> => {
    const cached = memory.get(api);
    if (cached && now() - cached.at < FRESH_MS) {
        return cached.spec;
    }
    const persist = api.baseUrl.startsWith("https://");
    const path = cacheFileOf(env, api.baseUrl);
    const disk = persist ? readDisk(path) : null;
    if (disk && now() - disk.at < FRESH_MS) {
        memory.set(api, disk);
        return disk.spec;
    }
    try {
        const spec = await api.get<Spec>("/openapi.json", undefined, {
            timeoutMs,
        });
        const entry = { at: now(), spec };
        memory.set(api, entry);
        if (persist) {
            writeDisk(path, entry);
        }
        return spec;
    } catch (error) {
        const stale = disk ?? cached;
        if (stale) {
            return stale.spec;
        }
        throw new GumError(
            "spec_unavailable",
            `Couldn't load the API's spec from ${api.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }
};

/** Operations the live API has that this build doesn't know, signed submits excluded. */
export const liveOnlyOperations = async (
    api: Api,
    env: Env,
    options?: { timeoutMs?: number }
): Promise<Operation[]> => {
    const known = new Set(
        TRADING_API.operations.map((operation) => operation.operationId)
    );
    return parseOperations(await loadLiveSpec(api, env, options))
        .filter((operation) => !known.has(operation.operationId))
        .map(({ requiredBody, response: _response, ...operation }) =>
            requiredBody.includes("signature")
                ? {
                      ...operation,
                      exclude:
                          "Submits a signed transaction; this CLI only signs through its own signed commands.",
                  }
                : operation
        );
};
