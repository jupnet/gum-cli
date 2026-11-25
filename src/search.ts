import type { Context } from "./context";
import { liveOnlyOperations } from "./live";
import { COMMANDS } from "./tree";

export type SearchDoc = {
    command: string;
    /** The command's own words, which outweigh any other match. */
    path: string[];
    summary: string;
    text: string;
};

const WORD = /[a-z0-9]+/g;
const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "can",
    "do",
    "for",
    "how",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "some",
    "the",
    "to",
    "what",
    "with",
]);

const wordsOf = (text: string) => text.toLowerCase().match(WORD) ?? [];

/** One letter added, dropped, changed or swapped with its neighbour: "withdrwa". */
const oneTypo = (left: string, right: string) => {
    if (Math.abs(left.length - right.length) > 1 || left === right) {
        return false;
    }
    if (left.length === right.length) {
        const differ = [...left].flatMap((char, index) =>
            char === right[index] ? [] : [index]
        );
        const [first, second] = differ;
        if (
            differ.length === 2 &&
            first !== undefined &&
            second === first + 1 &&
            left[first] === right[second] &&
            left[second] === right[first]
        ) {
            return true;
        }
    }
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if (edits > 1) {
            return false;
        }
        if (left.length > right.length) {
            i += 1;
        } else if (right.length > left.length) {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }
    return edits + (left.length - i) + (right.length - j) <= 1;
};

/**
 * Ranks commands for a plain-language task, e.g. "withdraw usdc to base".
 * A command's own words count most, then whole words, then prefixes and
 * single typos; results under half the best score are dropped as noise.
 */
export const rank = (query: string, docs: SearchDoc[], limit = 5) => {
    const wanted = [...new Set(wordsOf(query))].filter(
        (word) => !STOP_WORDS.has(word)
    );
    return docs
        .map((doc) => {
            const words = [...new Set(wordsOf(doc.text))];
            const own = new Set(doc.path);
            let score = 0;
            for (const word of wanted) {
                if (own.has(word)) {
                    score += 3;
                } else if (words.includes(word)) {
                    score += 2;
                } else if (
                    word.length > 2 &&
                    words.some(
                        (candidate) =>
                            candidate.length > 2 &&
                            (candidate.startsWith(word) ||
                                word.startsWith(candidate))
                    )
                ) {
                    score += 1;
                } else if (
                    word.length > 3 &&
                    words.some((candidate) => oneTypo(word, candidate))
                ) {
                    score += 1;
                }
            }
            return { doc, score };
        })
        .filter((result) => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .filter(
            (result, _, ranked) => result.score * 2 >= (ranked[0]?.score ?? 0)
        )
        .slice(0, limit)
        .map(({ doc }) => ({ command: doc.command, summary: doc.summary }));
};

export const commandDocs = (): SearchDoc[] =>
    COMMANDS.map((command) => ({
        command: command.usage,
        path: command.path,
        summary: command.summary,
        text: [
            command.path.join(" "),
            command.summary,
            ...command.keywords,
        ].join(" "),
    }));

/** Commands first; operations only the live API has come as `gumag api` calls. */
export const search = async (query: string, context?: Context) => {
    let live: SearchDoc[] = [];
    if (context) {
        try {
            live = (
                await liveOnlyOperations(context.api, context.env, {
                    timeoutMs: 1500,
                })
            )
                .filter((operation) => !(operation.exclude || operation.stream))
                .map((operation) => ({
                    command: [
                        `gumag api ${operation.operationId}`,
                        ...operation.inputs
                            .filter((input) => input.required)
                            .map((input) => `--${input.flag} <${input.field}>`),
                    ].join(" "),
                    path: [operation.operationId.toLowerCase()],
                    summary: operation.summary,
                    text: [
                        operation.operationId,
                        operation.summary,
                        operation.description,
                        operation.route,
                    ].join(" "),
                }));
        } catch {
            live = [];
        }
    }
    return { query, results: rank(query, [...commandDocs(), ...live]) };
};
