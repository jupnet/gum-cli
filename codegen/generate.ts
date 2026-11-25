import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import annotations from "../apis/trading-api/cli";
import spec from "../apis/trading-api/openapi.json" with { type: "json" };
import type { Spec } from "../src/openapi";
import { buildApi } from "./build";

// `bun run generate` rebuilds src/generated/<api>.json from each API's snapshot
// and annotations. With --check it only reports whether the committed files are
// current, and fails when they aren't.

export const APIS = [
    { annotations, name: "trading-api", spec: spec as Spec },
] as const;

export const generatedUrl = (name: string) =>
    new URL(`../src/generated/${name}.json`, import.meta.url);

/** The file contents `generate` writes for an API. */
export const render = (api: (typeof APIS)[number]) =>
    `${JSON.stringify(buildApi(api.spec, api.annotations), null, 2)}\n`;

const readJson = (url: URL): unknown => {
    try {
        return JSON.parse(readFileSync(url, "utf8"));
    } catch {
        return null;
    }
};

if (import.meta.main) {
    const check = process.argv.includes("--check");
    for (const api of APIS) {
        const target = generatedUrl(api.name);
        const fresh = render(api);
        if (!check) {
            writeFileSync(target, fresh);
            console.log(`Wrote ${target.pathname}`);
        } else if (!isDeepStrictEqual(readJson(target), JSON.parse(fresh))) {
            console.error(
                `${target.pathname} is out of date. Run \`bun run generate\` and commit it.`
            );
            process.exitCode = 1;
        }
    }
}
