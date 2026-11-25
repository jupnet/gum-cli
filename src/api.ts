export const DEFAULT_API_URL = "https://api.gum.ag/app/v1";

export const NETWORKS = {
    devnet: "https://dev-api.gum.ag/app/v1",
    mainnet: DEFAULT_API_URL,
} as const;

export type Network = keyof typeof NETWORKS;

const TRAILING_SLASHES = /\/+$/;
const LINE_BREAK = /\r?\n/;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Every failure the CLI reports: the API's own `{ code, message, details }`,
 * or one of the CLI's (network_error, no_wallet, ambiguous_token, …).
 */
export class GumError extends Error {
    readonly code: string;
    readonly status: number | null;
    readonly details: unknown;

    constructor(
        code: string,
        message: string,
        options: {
            cause?: unknown;
            details?: unknown;
            status?: number | null;
        } = {}
    ) {
        super(
            message,
            options.cause === undefined ? undefined : { cause: options.cause }
        );
        this.code = code;
        this.status = options.status ?? null;
        this.details = options.details;
    }
}

export const toErrorBody = (error: unknown) => {
    if (error instanceof GumError) {
        return {
            error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined
                    ? {}
                    : { details: error.details }),
            },
        };
    }
    return {
        error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
        },
    };
};

export type Query = Record<string, number | string | undefined>;

export type Api = {
    baseUrl: string;
    get: <T>(
        path: string,
        query?: Query,
        options?: { timeoutMs?: number }
    ) => Promise<T>;
    post: <T>(path: string, body: unknown) => Promise<T>;
    /** A server-sent events stream: one parsed `data:` message per item. */
    stream: (
        path: string,
        signal?: AbortSignal
    ) => Promise<AsyncIterable<unknown>>;
};

type ErrorShape = {
    error?: { code?: string; details?: unknown; message?: string };
};

const parseData = (data: string): unknown => {
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
};

/** Parses a text/event-stream body: comments and fields other than data are skipped. */
export async function* readEvents(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(LINE_BREAK);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (line === "") {
                if (data.length > 0) {
                    yield parseData(data.join("\n"));
                    data = [];
                }
            } else if (line.startsWith("data:")) {
                data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
            }
        }
    }
    if (buffer.startsWith("data:")) {
        data.push(buffer.slice(buffer.startsWith("data: ") ? 6 : 5));
    }
    if (data.length > 0) {
        yield parseData(data.join("\n"));
    }
}

export const createApi = (
    baseUrl = process.env.GUM_API_URL || DEFAULT_API_URL,
    fetchImpl: typeof fetch = fetch,
    { userAgent = "gumag" }: { userAgent?: string } = {}
): Api => {
    const root = baseUrl.replace(TRAILING_SLASHES, "");

    const send = async (
        method: "GET" | "POST",
        path: string,
        init: {
            accept?: string;
            body?: unknown;
            query?: Query;
            signal?: AbortSignal;
        }
    ) => {
        const url = new URL(`${root}${path}`);
        for (const [key, value] of Object.entries(init.query ?? {})) {
            if (value !== undefined && value !== "") {
                url.searchParams.set(key, String(value));
            }
        }
        const headers: Record<string, string> = { "user-agent": userAgent };
        if (init.accept) {
            headers.accept = init.accept;
        }
        if (init.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        let response: Response;
        try {
            response = await fetchImpl(url, {
                body:
                    init.body === undefined
                        ? undefined
                        : JSON.stringify(init.body),
                headers,
                method,
                signal: init.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new GumError(
                    "timeout",
                    `${root} didn't answer in time.`,
                    {
                        cause: error,
                    }
                );
            }
            if (error instanceof Error && error.name === "AbortError") {
                throw error;
            }
            throw new GumError(
                "network_error",
                `Couldn't reach ${root}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }
        if (!response.ok) {
            const text = await response.text();
            let data: unknown = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            const error = (data as ErrorShape | null)?.error;
            throw new GumError(
                error?.code ?? "http_error",
                error?.message ??
                    `${method} ${path} returned ${response.status}`,
                { details: error?.details, status: response.status }
            );
        }
        return response;
    };

    const json = async <T>(
        method: "GET" | "POST",
        path: string,
        init: { body?: unknown; query?: Query; timeoutMs?: number }
    ): Promise<T> => {
        const response = await send(method, path, {
            ...init,
            signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        try {
            return (text ? JSON.parse(text) : null) as T;
        } catch (error) {
            throw new GumError(
                "invalid_response",
                `${method} ${path} didn't return JSON.`,
                { cause: error }
            );
        }
    };

    return {
        baseUrl: root,
        get: (path, query, options) =>
            json("GET", path, { query, timeoutMs: options?.timeoutMs }),
        post: (path, body) => json("POST", path, { body }),
        stream: async (path, signal) => {
            const response = await send("GET", path, {
                accept: "text/event-stream",
                signal,
            });
            if (!response.body) {
                throw new GumError(
                    "invalid_response",
                    `GET ${path} didn't stream.`
                );
            }
            return readEvents(response.body);
        },
    };
};
