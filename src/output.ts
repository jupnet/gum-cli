import { styleText } from "node:util";

export type OutputMode = "compact" | "pretty";

const TOKEN =
    /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Colors pretty JSON for a terminal: keys, strings, numbers and literals. */
const colorize = (text: string) =>
    text.replace(
        TOKEN,
        (match, string?: string, colon?: string, literal?: string) => {
            if (string !== undefined) {
                return colon
                    ? `${styleText("cyan", string)}${colon}`
                    : styleText("green", string);
            }
            if (literal !== undefined) {
                return styleText("magenta", match);
            }
            return styleText("yellow", match);
        }
    );

/** One JSON value as the CLI prints it, without the trailing newline. */
export const formatJson = (
    value: unknown,
    mode: OutputMode,
    colors = false
) => {
    if (mode === "compact") {
        return JSON.stringify(value);
    }
    const text = JSON.stringify(value, null, 2);
    return colors ? colorize(text) : text;
};
