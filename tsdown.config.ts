import { defineConfig } from "tsdown";

// One executable file. Runtime dependencies stay external: npx installs them.
export default defineConfig({
    clean: true,
    dts: false,
    entry: { cli: "./src/cli.ts" },
    format: ["esm"],
    outDir: "./dist",
    platform: "node",
    target: "node22",
});
