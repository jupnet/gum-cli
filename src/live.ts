import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
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
// none when the API can't be reached (bounded to 24 hours).

const FRESH_MS = 10 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;

type Entry = { at: number; spec: Spec };

const memory = new WeakMap<Api, Entry>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isFresh = (at: number, current: number) =>
    at <= current && current - at < FRESH_MS;

const isUsableStale = (at: number, current: number) =>
    at <= current && current - at < MAX_STALE_MS;

export const cacheFileOf = (env: Env, baseUrl: string) =>
    join(
        env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "gumag",
        `${createHash("sha256").update(baseUrl).digest("hex")}.json`
    );

const readDisk = (path: string): Entry | null => {
    try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!isPlainObject(entry)) {
            return null;
        }
        const { at, spec } = entry;
        return typeof at === "number" &&
            Number.isFinite(at) &&
            isPlainObject(spec)
            ? { at, spec: spec as Spec }
            : null;
    } catch {
        return null;
    }
};

const writeDisk = (path: string, entry: Entry) => {
    const dir = dirname(path);
    const tmp = join(
        dir,
        `.spec.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    );
    try {
        mkdirSync(dir, { mode: 0o700, recursive: true });
        chmodSync(dir, 0o700);
        writeFileSync(tmp, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // A cache that can't be written only costs a fetch next time.
        }
    }
};

export const loadLiveSpec = async (
    api: Api,
    env: Env,
    { now = Date.now, timeoutMs = 5000 } = {}
): Promise<Spec> => {
    const current = now();
    const cached = memory.get(api);
    if (cached && isFresh(cached.at, current)) {
        return cached.spec;
    }
    const persist = api.baseUrl.startsWith("https://");
    const path = cacheFileOf(env, api.baseUrl);
    const disk = persist ? readDisk(path) : null;
    if (disk && isFresh(disk.at, current)) {
        memory.set(api, disk);
        return disk.spec;
    }
    try {
        const spec = await api.get<Spec>("/openapi.json", undefined, {
            timeoutMs,
        });
        if (!isPlainObject(spec)) {
            throw new GumError(
                "invalid_response",
                "GET /openapi.json didn't return a JSON object."
            );
        }
        const entry = { at: now(), spec };
        memory.set(api, entry);
        if (persist) {
            writeDisk(path, entry);
        }
        return spec;
    } catch (error) {
        const stale =
            (disk && isUsableStale(disk.at, now()) ? disk : null) ??
            (cached && isUsableStale(cached.at, now()) ? cached : null);
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
