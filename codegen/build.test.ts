import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Spec } from "../src/openapi";
import { buildApi } from "./build";
import { APIS, generatedUrl, render } from "./generate";

describe("the generated CLI", () => {
    test.each(APIS.map((api) => [api.name, api]))(
        "src/generated/%s.json is current (run `bun run generate`)",
        (_, api) => {
            expect(
                JSON.parse(readFileSync(generatedUrl(api.name), "utf8"))
            ).toEqual(JSON.parse(render(api)));
        }
    );
});

const ORDER_USAGE = /^gumag order <token> <amount>/;

// A small API with a quote, its signed submit and status, a list and a
// stream: enough for every rule. It builds as is; each test breaks one thing.
const spec = (): Spec => ({
    components: {
        schemas: {
            Quote: {
                properties: {
                    message: { type: "string" },
                    signer: { type: "object" },
                    transaction: { type: "string" },
                    usdValue: { type: ["string", "null"] },
                },
            },
            Status: { properties: { final: { type: "boolean" }, id: {} } },
        },
    },
    info: { title: "Fixture", version: "1.0.0" },
    paths: {
        "/items": {
            get: {
                operationId: "listItems",
                parameters: [
                    { in: "query", name: "cursor", schema: { type: "string" } },
                ],
                responses: {
                    "200": {
                        content: {
                            "application/json": {
                                schema: {
                                    properties: {
                                        items: { type: "array" },
                                        nextCursor: {
                                            type: ["string", "null"],
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        "/orders": {
            post: {
                operationId: "submitOrder",
                requestBody: {
                    content: {
                        "application/json": {
                            schema: {
                                properties: {
                                    signature: { type: "string" },
                                    transaction: { type: "string" },
                                },
                                required: ["transaction", "signature"],
                            },
                        },
                    },
                },
            },
        },
        "/orders/{id}": {
            get: {
                operationId: "getOrder",
                parameters: [{ in: "path", name: "id", required: true }],
                responses: {
                    "200": {
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Status" },
                            },
                        },
                    },
                },
            },
        },
        "/orders/{id}/events": {
            get: {
                operationId: "streamOrder",
                parameters: [{ in: "path", name: "id", required: true }],
                responses: {
                    "200": { content: { "text/event-stream": {} } },
                },
            },
        },
        "/orders/quote": {
            post: {
                operationId: "quoteOrder",
                requestBody: {
                    content: {
                        "application/json": {
                            schema: {
                                properties: {
                                    address: { type: "string" },
                                    amount: { type: "string" },
                                    chainId: { type: "integer" },
                                    token: { type: "string" },
                                },
                                required: [
                                    "address",
                                    "amount",
                                    "chainId",
                                    "token",
                                ],
                            },
                        },
                    },
                },
                responses: {
                    "200": {
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/Quote" },
                            },
                        },
                    },
                },
            },
        },
    },
    servers: [{ url: "https://example.test/v1" }],
});

const annotations = () => ({
    api: "fixture",
    flags: { chainId: "chain" },
    operations: {
        getOrder: { commands: [{ path: ["orders", "get"] }] },
        listItems: {
            commands: [
                {
                    path: ["items", "list"],
                    run: {
                        cursor: "cursor",
                        items: "items",
                        kind: "paginate",
                        next: "nextCursor",
                    },
                },
            ],
        },
        quoteOrder: {
            commands: [
                {
                    params: {
                        address: { hidden: true },
                        token: { resolve: "token" },
                    },
                    path: ["orders", "create"],
                    run: {
                        kind: "signed",
                        status: "getOrder",
                        submit: "submitOrder",
                        usd: "usdValue",
                        waitSeconds: 60,
                    },
                    shortcuts: [
                        {
                            args: ["token", "amount"],
                            name: "order",
                            summary: "Order.",
                        },
                    ],
                },
            ],
        },
        streamOrder: {
            commands: [
                {
                    path: ["orders", "watch"],
                    run: {
                        fallback: "getOrder",
                        kind: "stream",
                        until: "final",
                    },
                },
            ],
        },
        submitOrder: {
            exclude: "Signed submit, only orders create signs one.",
        },
    },
    resolve: { address: "wallet" },
});

type Annotations = ReturnType<typeof annotations>;

const fails = (
    change: (value: Annotations, fixture: Spec) => void,
    message: string
) => {
    const value = annotations();
    const fixture = spec();
    change(value, fixture);
    expect(() => buildApi(fixture, value)).toThrow(message);
};

describe("buildApi", () => {
    test("builds the fixture: positionals, flags, CLI-only inputs, shortcuts, exclusions", () => {
        const built = buildApi(spec(), annotations());
        const create = built.commands.find(
            (command) => command.path.join(" ") === "orders create"
        );
        expect(create?.hidden).toEqual({ address: "wallet" });
        expect(create?.usage).toBe(
            "gumag orders create --amount <amount> --token <token> [--chain <id>] [--dry-run] [--yes] [--max-usd <usd>] [--no-wait] [--timeout <seconds>]"
        );
        expect(
            built.commands.find((command) => command.path[0] === "order")
        ).toMatchObject({
            shortcutOf: "orders create",
            usage: expect.stringMatching(ORDER_USAGE),
        });
        expect(
            built.commands.find(
                (command) => command.path.join(" ") === "orders get"
            )?.inputs[0]
        ).toMatchObject({ field: "id", position: 0, required: true });
        expect(
            built.operations.find(
                (operation) => operation.operationId === "submitOrder"
            )
        ).toMatchObject({ exclude: expect.any(String) });
        expect(built.server).toBe("https://example.test/v1");
    });

    test("every operation needs an annotation, and the error says how to add one", () => {
        fails((value) => {
            Reflect.deleteProperty(value.operations, "getOrder");
        }, 'getOrder: { commands: [{ path: ["<resource>", "<verb>"] }] }');
        fails((value) => {
            Object.assign(value.operations, {
                goneOperation: { exclude: "Left the API long ago." },
            });
        }, "goneOperation is annotated but isn't in the spec");
    });

    test("a signed submit must be excluded, so only a signed command can call it", () => {
        fails((value) => {
            Object.assign(value.operations, {
                submitOrder: { commands: [{ path: ["orders", "submit"] }] },
            });
        }, "submitOrder takes a signature");
    });

    test("paths end in a known verb, aren't the CLI's own and aren't taken twice", () => {
        fails((value) => {
            value.operations.getOrder.commands[0] = {
                path: ["orders", "fetch"],
            };
        }, '"fetch" isn\'t a verb');
        fails((value) => {
            value.operations.getOrder.commands[0] = { path: ["auth", "get"] };
        }, "auth is the CLI's own command");
        fails((value) => {
            value.operations.listItems.commands[0] = {
                ...value.operations.listItems.commands[0],
                path: ["orders", "get"],
            } as never;
        }, "Two commands are called orders get");
    });

    test("one field keeps one flag across commands", () => {
        fails((value) => {
            Object.assign(
                value.operations.quoteOrder.commands[0]?.params ?? {},
                {
                    chainId: { flag: "network-id" },
                }
            );
            value.operations.quoteOrder.commands.push({
                path: ["orders", "quote"],
            } as never);
        }, "chainId is --");
    });

    test("signed, paginated and streamed runs must fit the spec", () => {
        fails((value) => {
            (
                value.operations.quoteOrder.commands[0]?.run as { usd: string }
            ).usd = "priceUsd";
        }, "needs priceUsd in quoteOrder's response");
        fails((value) => {
            (
                value.operations.listItems.commands[0]?.run as { next: string }
            ).next = "next";
        }, "needs next in listItems's response");
        fails((value) => {
            value.operations.getOrder.commands[0] = {
                path: ["orders", "get"],
                run: { kind: "stream" },
            } as never;
        }, "doesn't stream");
        fails((_, fixture) => {
            Reflect.deleteProperty(
                fixture.components?.schemas?.Status?.properties ?? {},
                "final"
            );
        }, "needs final in getOrder's response");
    });

    test("a hidden field needs a resolver, and positionals run in order", () => {
        fails((value) => {
            value.resolve = {} as never;
        }, "the hidden address needs a resolver");
        fails((value) => {
            value.operations.quoteOrder.commands[0]?.shortcuts?.splice(0, 1, {
                args: ["chainId", "amount"],
                name: "order",
                summary: "Order.",
            });
        }, "the required amount can't follow the optional chainId");
    });

    test("annotations are checked strictly", () => {
        fails((value) => {
            Object.assign(value, { colour: "blue" });
        }, "Invalid annotations");
    });
});
