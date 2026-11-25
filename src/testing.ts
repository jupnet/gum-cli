import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import spec from "../apis/trading-api/openapi.json" with { type: "json" };
import type { Env } from "./agent";
import { type Api, GumError, type Query } from "./api";
import { parseOperations, type Spec } from "./openapi";

type Handler = (body: unknown, query?: Query) => unknown;
type StreamHandler = () => unknown[] | AsyncIterable<unknown>;

const OPERATIONS = parseOperations(spec as Spec);
const PATH_PARAM = /\{\w+\}/g;
const DISCOVERY = new Set(["GET /openapi.json"]);

const operationFor = (method: string, path: string) =>
    OPERATIONS.find(
        (operation) =>
            operation.method === method &&
            new RegExp(
                `^${operation.route.replace(PATH_PARAM, "[^/]+")}$`
            ).test(path)
    );

/**
 * Fails any call the CLI makes that the Trading API's spec doesn't have, or
 * any query parameter or body field the operation doesn't take: the committed
 * snapshot stays in sync with the live API.
 */
const checkCall = (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    query: Query | undefined,
    undeclared: string[]
) => {
    if (
        DISCOVERY.has(`${method} ${path}`) ||
        undeclared.includes(`${method} ${path}`)
    ) {
        return;
    }
    const operation = operationFor(method, path);
    if (!operation) {
        throw new Error(`${method} ${path} isn't in the Trading API spec`);
    }
    const takes = (where: string, field: string) =>
        operation.inputs.some(
            (input) => input.in === where && input.field === field
        );
    for (const [name, value] of Object.entries(query ?? {})) {
        if (value !== undefined && !takes("query", name)) {
            throw new Error(`${method} ${path}: no query parameter ${name}`);
        }
    }
    for (const [name, value] of Object.entries(
        (body ?? {}) as Record<string, unknown>
    )) {
        if (value !== undefined && !takes("body", name)) {
            throw new Error(`${method} ${path}: no body field ${name}`);
        }
    }
};

async function* replay(messages: unknown[] | AsyncIterable<unknown>) {
    for await (const message of messages) {
        yield message;
    }
}

export type Call = {
    body?: unknown;
    method: "GET" | "POST" | "STREAM";
    path: string;
    query?: Query;
};

/**
 * An in-memory Api: "GET /path", "POST /path" or "STREAM /path" → handler.
 * Records every call. `undeclared` lists routes only the live spec has
 * (`api`, `call_api`), which the snapshot doesn't cover.
 */
export const fakeApi = (
    routes: Record<string, Handler | StreamHandler>,
    { undeclared = [] }: { undeclared?: string[] } = {}
) => {
    const calls: Call[] = [];
    const respond = <T>(
        method: "GET" | "POST",
        path: string,
        body?: unknown,
        query?: Query
    ) => {
        checkCall(method, path, body, query, undeclared);
        calls.push({ body, method, path, query });
        const handler = routes[`${method} ${path}`] as Handler | undefined;
        if (!handler) {
            return Promise.reject(
                new GumError("not_found", `No route for ${method} ${path}`, {
                    status: 404,
                })
            );
        }
        try {
            return Promise.resolve(handler(body, query) as T);
        } catch (error) {
            return Promise.reject(error);
        }
    };
    const api: Api = {
        baseUrl: "http://fake.test/v1",
        get: (path, query) => respond("GET", path, undefined, query),
        post: (path, body) => respond("POST", path, body),
        stream: (path) => {
            checkCall("GET", path, undefined, undefined, undeclared);
            calls.push({ method: "STREAM", path });
            const handler = routes[`STREAM ${path}`] as
                | StreamHandler
                | undefined;
            if (!handler) {
                return Promise.reject(
                    new GumError("not_found", `No stream ${path}`, {
                        status: 404,
                    })
                );
            }
            try {
                return Promise.resolve(replay(handler()));
            } catch (error) {
                return Promise.reject(error);
            }
        },
    };
    return { api, calls };
};

/** An environment with its own empty config and cache, so tests never read yours. */
export const tempEnv = (extra: Env = {}): Env => ({
    XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "gumag-cache-")),
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gumag-config-")),
    ...extra,
});

// Well-known public Hardhat/Anvil default test Account #1 private key (never holds real funds).
export const EVM_KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const SOL = "So11111111111111111111111111111111111111112";
export const SOLANA_ACCOUNT = "7jqXWdiyYkY9XUStYhbGzSgn1VCr9tMF4LNCK52oG76U";
