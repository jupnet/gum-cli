import { GumError, isLoopbackHost, toErrorBody } from "../api";
import type { Context } from "../context";
import type {
    Command,
    Operation,
    SynchronousSubmissionExpectation,
} from "../model";
import { formatJson } from "../output";
import { limitOf, requireWallet } from "../profile";
import {
    type Activity,
    checkLimit,
    checkSigner,
    messageBytes,
    type Signer,
    waitUntil,
} from "../trade";
import { operationById, TRADING_API } from "../tree";
import { pricedOf } from "./request";
import { requestOf, type Values } from "./values";

type Quote = {
    expiresAt?: unknown;
    message?: unknown;
    signer?: Signer;
    transaction?: unknown;
    [field: string]: unknown;
};

export type SignedOptions = {
    dryRun: boolean;
    /** --max-usd; the lowest of it, GUM_MAX_TRADE_USD and the profile's applies. */
    maxUsd?: number;
    /** MCP: sign only under a configured USD limit. */
    requireLimit?: boolean;
    timeoutMs: number;
    wait: boolean;
    /** Agreed up front: --yes, or the MCP client's own confirmation. */
    yes: boolean;
};

const QUOTE_ATTEMPTS = 3;
const EXPIRY_MARGIN_MS = 1000;

const expired = (quote: Quote) =>
    typeof quote.expiresAt === "string" &&
    Date.parse(quote.expiresAt) - Date.now() < EXPIRY_MARGIN_MS;

const hostOf = (url: string) => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

const isGumEndpoint = (urlString: string) => {
    try {
        const parsed = new URL(urlString);
        const name = parsed.hostname;
        if (parsed.protocol === "https:") {
            return name === "gum.ag" || name.endsWith(".gum.ag");
        }
        return parsed.protocol === "http:" && isLoopbackHost(name);
    } catch {
        return false;
    }
};

const operation = (operationId: string) => {
    const found = operationById(operationId);
    if (!found) {
        throw new GumError("internal_error", `No operation ${operationId}.`);
    }
    return found;
};

/**
 * A submit that timed out, lost its connection, met a server error or got an
 * unreadable 2xx reply may still have gone through, so it says not to submit
 * again. A 4xx means the API answered and turned it down: that error passes
 * through unchanged.
 */
const submitFailure = (error: unknown, recoveryCommand: string) => {
    if (
        !(error instanceof GumError) ||
        !(
            error.code === "timeout" ||
            error.code === "network_error" ||
            error.code === "invalid_response" ||
            (error.status ?? 0) >= 500
        )
    ) {
        return error;
    }
    return new GumError(
        error.code,
        `${error.message} The submission may still have gone through. Do not submit again; check \`${recoveryCommand}\` with the same profile and network first.`,
        {
            cause: error,
            details: {
                cause: toErrorBody(error).error,
                retrySubmission: false,
                submissionUnknown: true,
            },
            status: error.status,
        }
    );
};

const isValidSynchronousSubmission = (
    value: unknown,
    expected?: SynchronousSubmissionExpectation,
    expectedAccount?: unknown
): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.account !== "string" ||
        record.account.trim().length === 0 ||
        typeof record.status !== "string" ||
        record.status.trim().length === 0 ||
        typeof record.type !== "string" ||
        record.type.trim().length === 0 ||
        typeof record.final !== "boolean"
    ) {
        return false;
    }
    if (
        typeof expectedAccount === "string" &&
        expectedAccount.trim().length > 0 &&
        record.account !== expectedAccount
    ) {
        return false;
    }
    if (!expected) {
        return true;
    }
    if (record.type !== expected.type) {
        return false;
    }
    if (!expected.statuses.includes(record.status)) {
        return false;
    }
    if (expected.final !== undefined && record.final !== expected.final) {
        return false;
    }
    return true;
};

/** The USD limit to sign under; MCP refuses to sign without one, including dry runs. */
export const limitFor = (
    context: Context,
    options: Pick<SignedOptions, "maxUsd" | "requireLimit">
) => {
    const limit = limitOf(options.maxUsd, context.env, context.settings);
    if (options.requireLimit && limit === undefined) {
        throw new GumError(
            "limit_required",
            "Signing over MCP needs a USD limit, including dry runs (which still sign locally). Set GUM_MAX_TRADE_USD in the MCP server's environment (a profile's own limit counts too). Use quote tools for unsigned quotes."
        );
    }
    return limit;
};

/**
 * Quote → limit and signer checks → confirmation → sign locally → submit →
 * wait. The only code that signs. Nothing reaches the key until the quote
 * passes the USD limit and someone (or --yes) has agreed to it.
 */
export const runSigned = async (
    command: Command,
    quoteOperation: Operation,
    context: Context,
    values: Values,
    options: SignedOptions
) => {
    const { run } = command;
    if (run.kind !== "signed") {
        throw new GumError(
            "internal_error",
            `${command.path.join(" ")} doesn't sign.`
        );
    }
    const wallet = requireWallet(context.env, context.settings);
    const limit = limitFor(context, options);
    const submit = operation(run.submit.operationId);
    const status = run.status ? operation(run.status.operationId) : null;
    const recoveryCommand = run.recovery ?? "gumag history list";
    const host = hostOf(context.api.baseUrl);

    for (let attempt = 1; ; attempt += 1) {
        const { body, path } = requestOf(quoteOperation, values);
        const quote = await context.api.post<Quote>(path, body);
        if (
            typeof quote?.message !== "string" ||
            typeof quote.transaction !== "string" ||
            !quote.signer
        ) {
            throw new GumError(
                "invalid_response",
                "The quote has no message to sign."
            );
        }
        checkLimit(quote[run.usd], limit);
        checkSigner(quote.signer, wallet);
        const priced = pricedOf(quote);

        if (!(options.yes || options.dryRun)) {
            if (!context.interactive) {
                throw new GumError(
                    "confirmation_required",
                    "Nothing was signed: no one is at the terminal to confirm. Check the quote in details, then run the same command with --yes to sign and submit it.",
                    { details: { quote: priced } }
                );
            }
            context.io.stderr(`${formatJson(priced, "pretty")}\n`);
            if (!isGumEndpoint(context.api.baseUrl)) {
                context.io.stderr(
                    `Warning: ${host} isn't gum.ag. You'd be signing a transaction it built.\n`
                );
            }
            const agreed = await context.io.confirm(
                `Sign and submit with ${wallet.address} on ${host}?`
            );
            if (!agreed) {
                throw new GumError(
                    "cancelled",
                    "Cancelled. Nothing was signed."
                );
            }
        }

        if (expired(quote)) {
            if (attempt < QUOTE_ATTEMPTS) {
                context.io.stderr(
                    `${JSON.stringify({ notice: "The quote expired before it was signed. Quoting again." })}\n`
                );
                continue;
            }
            throw new GumError(
                "quote_expired",
                "The quote expired before it was signed. Run the command again."
            );
        }

        const signature = await wallet.sign(
            messageBytes({ message: quote.message })
        );
        const submitted = await context.api
            .post<Activity>(submit.route, {
                ...(options.dryRun ? { dryRun: true } : {}),
                signature,
                transaction: quote.transaction,
            })
            .catch((error: unknown) => {
                throw options.dryRun
                    ? error
                    : submitFailure(error, recoveryCommand);
            });
        if (options.dryRun) {
            if (
                typeof submitted !== "object" ||
                submitted === null ||
                Array.isArray(submitted)
            ) {
                throw new GumError(
                    "invalid_response",
                    "The dry-run response was empty or malformed."
                );
            }
            return { ...submitted, quote: priced };
        }
        if (!status) {
            if (
                !isValidSynchronousSubmission(
                    submitted,
                    run.expect,
                    quote.account
                )
            ) {
                throw new GumError(
                    "invalid_response",
                    `The submission response was empty or incomplete. Its outcome is unknown. Do not submit again; check \`${recoveryCommand}\` with the same profile and network first.`,
                    {
                        details: {
                            retrySubmission: false,
                            submissionUnknown: true,
                        },
                    }
                );
            }
            return { ...submitted, quote: priced };
        }
        if (
            typeof submitted !== "object" ||
            submitted === null ||
            Array.isArray(submitted) ||
            typeof submitted.id !== "string" ||
            !submitted.id.trim()
        ) {
            throw new GumError(
                "invalid_response",
                "The submission response has no operation ID. Its outcome is unknown. Do not submit again; check account history.",
                { details: { retrySubmission: false, submissionUnknown: true } }
            );
        }
        if (!options.wait) {
            return { ...submitted, quote: priced };
        }
        try {
            const final = await waitUntil(
                () =>
                    context.api.get<Activity>(
                        requestOf(status, { id: submitted.id }).path
                    ),
                "final",
                options.timeoutMs
            );
            return { ...final, quote: priced };
        } catch (error) {
            const read = TRADING_API.commands.find(
                (candidate) =>
                    candidate.operationId === status.operationId &&
                    candidate.run.kind === "request" &&
                    candidate.run.readOnly
            );
            const recovery = read
                ? ["gumag", ...read.path, "--id", submitted.id, "--wait"]
                : ["gumag", "api", status.operationId, "--id", submitted.id];
            recovery.push("--profile", context.settings.profile);
            if (context.settings.network !== "custom") {
                recovery.push("--network", context.settings.network);
            }
            throw new GumError(
                "status_unavailable",
                `Submission ${submitted.id} was accepted, but its final status could not be read. Do not submit again; use the read-only recovery command in details.`,
                {
                    cause: error,
                    details: {
                        cause: toErrorBody(error).error,
                        id: submitted.id,
                        lastKnownStatus: submitted.status,
                        recovery: {
                            command: recovery,
                            operationId: status.operationId,
                            useSameEnvironment: true,
                        },
                        retrySubmission: false,
                        submissionAccepted: true,
                    },
                    status: error instanceof GumError ? error.status : null,
                }
            );
        }
    }
};
