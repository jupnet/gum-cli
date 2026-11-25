import { describe, expect, test } from "bun:test";
import { parseLine } from "./args";
import type { Input } from "./model";
import { fromJson, fromText } from "./validate";

const command = (argv: string[]) => {
    const line = parseLine(argv);
    if (line.kind !== "command") {
        throw new Error(`Expected a command, got ${JSON.stringify(line)}`);
    }
    return line;
};

describe("parseLine", () => {
    test("leading words pick the command; the rest are its arguments and flags", () => {
        const line = command([
            "swaps",
            "create",
            "--side",
            "buy",
            "--token=SOL",
            "--amount",
            "100000000.000000001",
            "--dry-run",
        ]);
        expect(line.command.path).toEqual(["swaps", "create"]);
        expect(line.flags).toEqual({
            amount: "100000000.000000001",
            "dry-run": true,
            side: "buy",
            token: "SOL",
        });
        expect(command(["buy", "SOL", "5", "-y"])).toMatchObject({
            flags: { yes: true },
            positionals: ["SOL", "5"],
        });
    });

    test("global flags go anywhere", () => {
        const line = command([
            "--profile",
            "bot",
            "balances",
            "--pretty",
            "get",
            "--network=devnet",
        ]);
        expect(line.command.path).toEqual(["balances", "get"]);
        expect(line.global).toMatchObject({
            network: "devnet",
            pretty: true,
            profile: "bot",
        });
    });

    test("switches take nothing but true or false; values can't be empty or doubled", () => {
        expect(command(["buy", "SOL", "5", "--dry-run=false"]).flags).toEqual({
            "dry-run": false,
        });
        expect(() => parseLine(["buy", "SOL", "5", "--dry-run=yes"])).toThrow(
            "--dry-run is a switch"
        );
        expect(() => parseLine(["buy", "SOL", "5", "--max-usd"])).toThrow(
            "--max-usd needs a value."
        );
        expect(() =>
            parseLine(["buy", "SOL", "5", "--max-usd", "--dry-run"])
        ).toThrow("--max-usd needs a value.");
        expect(() =>
            parseLine(["buy", "SOL", "5", "--chain", "1", "--chain=2"])
        ).toThrow("--chain is given twice.");
    });

    test("an unknown flag names the one that was probably meant", () => {
        expect(() => parseLine(["buy", "SOL", "5", "--dryRun"])).toThrow(
            "buy has no --dryRun. Did you mean --dry-run?"
        );
        expect(() => parseLine(["sell", "SOL", "1", "--max_usd", "5"])).toThrow(
            "Did you mean --max-usd?"
        );
        expect(() => parseLine(["chains", "list", "--all"])).toThrow(
            "chains list has no --all. It takes no flags."
        );
    });

    test("-- ends the flags", () => {
        expect(
            command(["tokens", "search", "--", "--weird"]).positionals
        ).toEqual(["--weird"]);
    });

    test("words named like Object.prototype members are words, not flags", () => {
        expect(
            command(["tokens", "search", "constructor", "toString"])
        ).toMatchObject({
            flags: {},
            positionals: ["constructor", "toString"],
        });
    });

    test("groups and unknown words come back for help or a suggestion", () => {
        expect(parseLine(["swaps"])).toMatchObject({ kind: "group" });
        expect(parseLine(["swaps", "quotes"])).toMatchObject({
            kind: "group",
            unknown: "quotes",
        });
        expect(parseLine(["swaps", "--help"])).toMatchObject({
            global: { help: true },
            kind: "group",
        });
        expect(parseLine([])).toMatchObject({ kind: "group" });
    });

    test("api passes flags it doesn't know on to the operation", () => {
        expect(
            command(["api", "getSwap", "--id", "abc", "--verbose"]).flags
        ).toEqual({ id: "abc", verbose: true });
    });
});

describe("integer arguments", () => {
    const chain: Input = {
        description: "Chain ID",
        field: "chainId",
        flag: "chain",
        in: "query",
        required: false,
        type: "integer",
    };

    test("chain names direct CLI and JSON callers to numeric chain discovery", () => {
        expect(fromText(chain, "900", "--chain")).toBe(900);
        expect(fromJson(chain, 900, "chainId")).toBe(900);
        expect(() => fromText(chain, "solana", "--chain")).toThrow(
            "--chain must be a whole number. Use a numeric chain ID from `gumag chains list`."
        );
        expect(() => fromJson(chain, "solana", "chainId")).toThrow(
            "chainId must be a whole number. Use a numeric chain ID from `gumag chains list`."
        );
    });

    test("unrelated integers keep their existing error", () => {
        const limit = { ...chain, field: "limit", flag: "limit" };
        expect(fromText(limit, "25", "--limit")).toBe(25);
        expect(fromJson(limit, 25, "limit")).toBe(25);
        expect(() => fromText(limit, "many", "--limit")).toThrow(
            "--limit must be a whole number."
        );
        expect(() => fromJson(limit, "many", "limit")).toThrow(
            "limit must be a whole number."
        );
    });
});
