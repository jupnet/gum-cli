import { describe, expect, test } from "bun:test";
import { GumError } from "./api";
import { runCommand } from "./main";
import { EVM_KEY, fakeApi, SOL, tempEnv } from "./testing";
import { evmWallet } from "./wallet";

const cases = [
    {
        argv: ["buy", SOL, "5", "--chain", "900"],
        group: "swaps",
        route: "/swap",
    },
    {
        argv: [
            "withdraw",
            "5",
            "USD",
            "--chain",
            "8453",
            "--to",
            "0x0000000000000000000000000000000000000042",
        ],
        group: "withdrawals",
        route: "/withdraw",
    },
];

const fixture = (
    route: string,
    failure?: GumError,
    submitError?: GumError,
    response: unknown = { final: false, id: "accepted-1", status: "pending" },
    finalStatus = "completed"
) => {
    let readFailure = failure;
    const routes = fakeApi({
        [`POST ${route}/quote`]: () => ({
            message: Buffer.from("recovery fixture").toString("base64"),
            signer: { address: evmWallet(EVM_KEY).address, signWith: "evm" },
            transaction: "fixture-transaction",
            usdValue: "5",
        }),
        [`POST ${route}`]: () => {
            if (submitError) throw submitError;
            return response;
        },
        [`GET ${route}/accepted-1`]: () => {
            if (readFailure) {
                const error = readFailure;
                readFailure = undefined;
                throw error;
            }
            return { final: true, id: "accepted-1", status: finalStatus };
        },
    });
    return { ...routes, env: tempEnv({ GUM_EVM_PRIVATE_KEY: EVM_KEY }) };
};

describe.each(cases)("$group status recovery", ({ argv, group, route }) => {
    test("a terminal failed activity is returned as an observed outcome", async () => {
        const setup = fixture(route, undefined, undefined, undefined, "failed");
        expect(await runCommand([...argv, "--yes"], setup)).toMatchObject({
            exitCode: 0,
            output: { final: true, id: "accepted-1", status: "failed" },
        });
    });

    test.each([null, {}, { id: "" }])(
        "a malformed submit response never claims a known accepted ID: %p",
        async (response) => {
            expect(
                (await runCommand([...argv, "--yes"], fixture(route))).exitCode
            ).toBe(0);
            const setup = fixture(route, undefined, undefined, response);
            expect(await runCommand([...argv, "--yes"], setup)).toMatchObject({
                exitCode: 1,
                output: {
                    error: {
                        code: "invalid_response",
                        details: {
                            retrySubmission: false,
                            submissionUnknown: true,
                        },
                    },
                },
            });
            expect(
                setup.calls.filter((call) => call.path === route)
            ).toHaveLength(1);
            expect(
                setup.calls.filter((call) => call.method === "GET")
            ).toHaveLength(0);
        }
    );

    test.each([
        new GumError("timeout", "Read timed out."),
        new GumError("http_error", "Service unavailable.", { status: 503 }),
    ])(
        "retains the accepted ID after %s and provides a working read-only command",
        async (failure) => {
            const normal = fixture(route);
            expect(await runCommand([...argv, "--yes"], normal)).toMatchObject({
                exitCode: 0,
                output: { final: true },
            });

            const failed = fixture(route, failure);
            const result = await runCommand(
                [...argv, "--yes", "--profile", "bot", "--network", "devnet"],
                failed
            );
            const command = [
                "gumag",
                group,
                "get",
                "--id",
                "accepted-1",
                "--wait",
                "--profile",
                "bot",
                "--network",
                "devnet",
            ];
            expect(result).toMatchObject({
                exitCode: 1,
                output: {
                    error: {
                        code: "status_unavailable",
                        details: {
                            cause: {
                                code: failure.code,
                                message: failure.message,
                            },
                            id: "accepted-1",
                            lastKnownStatus: "pending",
                            recovery: { command, useSameEnvironment: true },
                            retrySubmission: false,
                            submissionAccepted: true,
                        },
                    },
                },
            });
            expect(await runCommand(command.slice(1), failed)).toMatchObject({
                exitCode: 0,
                output: { final: true, id: "accepted-1" },
            });
            expect(
                failed.calls.filter((call) => call.path === route)
            ).toHaveLength(1);
            expect(JSON.stringify(result.output)).not.toContain(
                "fixture-transaction"
            );
        }
    );

    test("no-wait retains the accepted response without reading status", async () => {
        const setup = fixture(
            route,
            new GumError("timeout", "Read timed out.")
        );
        expect(
            await runCommand([...argv, "--yes", "--no-wait"], setup)
        ).toMatchObject({
            exitCode: 0,
            output: { final: false, id: "accepted-1", status: "pending" },
        });
        expect(
            setup.calls.filter((call) => call.method === "GET")
        ).toHaveLength(0);
    });

    test("a refused submit passes through unchanged and claims nothing", async () => {
        const normal = fixture(route);
        expect((await runCommand([...argv, "--yes"], normal)).exitCode).toBe(0);
        const setup = fixture(
            route,
            undefined,
            new GumError("rejected", "Submission rejected.", { status: 400 })
        );
        const result = await runCommand([...argv, "--yes"], setup);
        expect(result).toMatchObject({
            exitCode: 1,
            output: {
                error: { code: "rejected", message: "Submission rejected." },
            },
        });
        expect(JSON.stringify(result.output)).not.toContain("retrySubmission");
        expect(setup.calls.filter((call) => call.path === route)).toHaveLength(
            1
        );
        expect(
            setup.calls.filter((call) => call.method === "GET")
        ).toHaveLength(0);
    });

    test.each([
        new GumError("timeout", "Submission timed out."),
        new GumError("network_error", "Connection reset."),
        new GumError("http_error", "Bad gateway.", { status: 502 }),
        new GumError("invalid_response", "POST /swap didn't return JSON."),
    ])(
        "a submit that may have gone through says not to submit again: %s",
        async (failure) => {
            const setup = fixture(route, undefined, failure);
            expect(await runCommand([...argv, "--yes"], setup)).toMatchObject({
                exitCode: 1,
                output: {
                    error: {
                        code: failure.code,
                        details: {
                            cause: {
                                code: failure.code,
                                message: failure.message,
                            },
                            retrySubmission: false,
                            submissionUnknown: true,
                        },
                    },
                },
            });
            expect(
                setup.calls.filter((call) => call.path === route)
            ).toHaveLength(1);
            expect(
                setup.calls.filter((call) => call.method === "GET")
            ).toHaveLength(0);
        }
    );

    test("a dry run's failed check passes through: nothing can have executed", async () => {
        const setup = fixture(
            route,
            undefined,
            new GumError("timeout", "Check timed out.")
        );
        const result = await runCommand([...argv, "--dry-run"], setup);
        expect(result).toMatchObject({
            exitCode: 1,
            output: { error: { code: "timeout", message: "Check timed out." } },
        });
        expect(JSON.stringify(result.output)).not.toContain("retrySubmission");
    });
});
