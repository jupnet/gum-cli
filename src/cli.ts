#!/usr/bin/env node
import { main } from "./main";

main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
        `${JSON.stringify({ error: { code: "internal_error", message: String(error) } })}\n`
    );
    process.exitCode = 1;
});
