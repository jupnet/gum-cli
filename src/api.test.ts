import { afterEach, describe, expect, test } from "bun:test";
import { createApi, readEvents } from "./api";

const originalApiUrl = process.env.GUM_API_URL;

afterEach(() => {
    if (originalApiUrl === undefined) {
        Reflect.deleteProperty(process.env, "GUM_API_URL");
    } else {
        process.env.GUM_API_URL = originalApiUrl;
    }
});

describe("API base URL", () => {
    test("default requests retain the production gateway and version prefixes", async () => {
        Reflect.deleteProperty(process.env, "GUM_API_URL");
        const urls: string[] = [];
        const fetchImpl = ((input: URL) => {
            urls.push(input.toString());
            return Promise.resolve(Response.json({ tokens: [] }));
        }) as typeof fetch;
        const api = createApi(undefined, fetchImpl);

        await api.get("/tokens", { query: "SOL & ETH" });
        expect(api.baseUrl).toBe("https://api.gum.ag/app/v1");
        expect(urls).toEqual([
            "https://api.gum.ag/app/v1/tokens?query=SOL+%26+ETH",
        ]);
    });

    test("environment and explicit overrides preserve custom paths", () => {
        process.env.GUM_API_URL = "http://localhost:4000/v1///";
        expect(createApi().baseUrl).toBe("http://localhost:4000/v1");
        expect(createApi("http://127.0.0.1:4000/v1/").baseUrl).toBe(
            "http://127.0.0.1:4000/v1"
        );
        expect(createApi("http://[::1]:4000/v1/").baseUrl).toBe(
            "http://[::1]:4000/v1"
        );
        expect(createApi("https://custom.example/prefix/v1/").baseUrl).toBe(
            "https://custom.example/prefix/v1"
        );
    });

    test("refuses plaintext non-loopback URLs, embedded credentials, and query/fragment base URLs", () => {
        for (const bad of [
            "http://api.gum.ag/app/v1",
            "http://evil.example/v1",
            "ftp://api.gum.ag/app/v1",
            "https://user:pass@api.gum.ag/app/v1",
            "https://api.gum.ag/app/v1?x=1",
            "https://api.gum.ag/app/v1#frag",
            "not-a-url",
        ]) {
            expect(() => createApi(bad)).toThrow();
        }
    });

    test("blocks redirects and path traversal in request paths", async () => {
        const redirects: (RequestRedirect | undefined)[] = [];
        const fetchImpl = ((_: URL, init: RequestInit) => {
            redirects.push(init.redirect);
            return Promise.resolve(Response.json({ ok: true }));
        }) as typeof fetch;
        const api = createApi("https://api.example/app/v1", fetchImpl);
        await api.get("/chains");
        expect(redirects).toEqual(["error"]);

        for (const badPath of [
            "/../admin",
            "//evil.example/x",
            "tokens",
            "/tokens?injected=1",
            "/tokens#frag",
            "/tokens\\evil",
        ]) {
            await expect(api.get(badPath)).rejects.toMatchObject({
                code: "invalid_request",
            });
        }
    });
});

describe("requests", () => {
    test("send a User-Agent and turn the API's error body into a GumError", async () => {
        const seen: Headers[] = [];
        const fetchImpl = ((_: URL, init: RequestInit) => {
            seen.push(new Headers(init.headers));
            return Promise.resolve(
                Response.json(
                    {
                        error: {
                            code: "token_not_found",
                            details: { q: 1 },
                            message: "No such token.",
                        },
                    },
                    { status: 404 }
                )
            );
        }) as typeof fetch;
        const api = createApi("https://api.example/v1", fetchImpl, {
            userAgent: "gumag/9.9.9 (claude-code)",
        });
        await expect(api.get("/tokens")).rejects.toMatchObject({
            code: "token_not_found",
            details: { q: 1 },
            message: "No such token.",
            status: 404,
        });
        expect(seen[0]?.get("user-agent")).toBe("gumag/9.9.9 (claude-code)");
    });

    test("a request that takes too long is a timeout, not a hang", async () => {
        const fetchImpl = ((_: URL, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () =>
                    reject(init.signal?.reason)
                );
            })) as typeof fetch;
        const api = createApi("https://api.example/v1", fetchImpl);
        await expect(
            api.get("/chains", undefined, { timeoutMs: 10 })
        ).rejects.toMatchObject({ code: "timeout" });
    });
});

describe("readEvents", () => {
    const body = (text: string) =>
        new Response(text).body as ReadableStream<Uint8Array>;
    const all = async (stream: ReadableStream<Uint8Array>) => {
        const found: unknown[] = [];
        for await (const event of readEvents(stream)) {
            found.push(event);
        }
        return found;
    };

    test("one message per blank-line-terminated event; comments and other fields are skipped", async () => {
        expect(
            await all(
                body(
                    'retry: 3000\n: keep-alive\n\ndata: {"a":1}\n\nevent: x\r\ndata: {"b":\r\ndata: 2}\r\n\r\ndata: tail'
                )
            )
        ).toEqual([{ a: 1 }, { b: 2 }, "tail"]);
    });
});
