import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Api } from "./api";
import { cacheFileOf, loadLiveSpec } from "./live";
import { parseOperations, type Spec } from "./openapi";
import { tempEnv } from "./testing";

const httpsApi = (baseUrl: string, getSpec: () => Promise<unknown>): Api => ({
    baseUrl,
    get: () => getSpec() as Promise<never>,
    post: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
});

describe("live OpenAPI cache", () => {
    test("uses collision-resistant SHA-256 filenames and 0700/0600 permissions", async () => {
        const env = tempEnv();
        const dotPath = cacheFileOf(env, "https://api.gum.ag/app/v1");
        const dashPath = cacheFileOf(env, "https://api-gum.ag/app/v1");
        expect(dotPath).not.toBe(dashPath);

        const api = httpsApi("https://api.gum.ag/app/v1", () =>
            Promise.resolve({ paths: {} })
        );
        await loadLiveSpec(api, env, { now: () => 1_700_000_000_000 });
        expect(statSync(dirname(dotPath)).mode & 0o777).toBe(0o700);
        expect(statSync(dotPath).mode & 0o777).toBe(0o600);
    });

    test("ignores null specs and future timestamps in the disk cache", async () => {
        const env = tempEnv();
        const url = "https://api.gum.ag/app/v1";
        const path = cacheFileOf(env, url);
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });

        // Corrupt spec: null
        writeFileSync(path, JSON.stringify({ at: 1000, spec: null }));
        let fetches = 0;
        const freshSpec = { info: { version: "2.0.0" }, paths: {} };
        const api = httpsApi(url, () => {
            fetches += 1;
            return Promise.resolve(freshSpec);
        });
        expect(await loadLiveSpec(api, env, { now: () => 2000 })).toEqual(
            freshSpec
        );
        expect(fetches).toBe(1);

        // Poisoned future timestamp must not prevent refresh or be served as stale.
        const envFuture = tempEnv();
        const futurePath = cacheFileOf(envFuture, url);
        mkdirSync(dirname(futurePath), { mode: 0o700, recursive: true });
        writeFileSync(
            futurePath,
            JSON.stringify({
                at: 9_999_999_999_999,
                spec: { info: { version: "poison" }, paths: {} },
            })
        );
        let futureFetches = 0;
        const api2 = httpsApi(url, () => {
            futureFetches += 1;
            return Promise.resolve(freshSpec);
        });
        expect(
            await loadLiveSpec(api2, envFuture, { now: () => 2000 })
        ).toEqual(freshSpec);
        expect(futureFetches).toBe(1);

        // Stale cache older than 24h is rejected when upstream fails.
        const envOld = tempEnv();
        const oldPath = cacheFileOf(envOld, url);
        mkdirSync(dirname(oldPath), { mode: 0o700, recursive: true });
        writeFileSync(
            oldPath,
            JSON.stringify({ at: 1000, spec: { paths: {} } })
        );
        const failing = httpsApi(url, () => Promise.reject(new Error("down")));
        await expect(
            loadLiveSpec(failing, envOld, {
                now: () => 1000 + 25 * 60 * 60 * 1000,
            })
        ).rejects.toMatchObject({ code: "spec_unavailable" });
    });
});

describe("parseOperations hardening", () => {
    test("skips unsafe routes and guards against malformed schemas and prototype keys", () => {
        const spec = {
            components: { schemas: {} },
            paths: {
                "/../escape": {
                    get: { operationId: "escapePath" },
                },
                "//evil.example/steal": {
                    get: { operationId: "evilHost" },
                },
                "/ok": {
                    post: {
                        operationId: "safeOp",
                        requestBody: {
                            content: {
                                "application/json": {
                                    schema: {
                                        properties: {
                                            badRef: {
                                                $ref: "#/components/schemas/toString",
                                            },
                                            constructor: { type: "string" },
                                        },
                                        required: ["constructor"],
                                    },
                                },
                            },
                        },
                    },
                },
                "/query?injected=1": {
                    get: { operationId: "queryRoute" },
                },
            },
        } as unknown as Spec;

        const ops = parseOperations(spec, {});
        expect(ops.map((op) => op.operationId)).toEqual(["safeOp"]);
        expect(ops[0]?.inputs).toEqual([
            {
                description: "",
                field: "badRef",
                flag: "bad-ref",
                in: "body",
                required: false,
                type: "string",
            },
            {
                description: "",
                field: "constructor",
                flag: "constructor",
                in: "body",
                required: true,
                type: "string",
            },
        ]);
    });
});
