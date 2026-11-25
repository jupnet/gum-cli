import { DOCS_URL } from "./help";

/** `gumag cli agents-md`: a section for a project's AGENTS.md. */
export const agentsMd = () => `## GUM (gumag)

This project trades on GUM with the \`gumag\` CLI (${DOCS_URL}).

- Don't page through \`--help\`. Find the command for a task with
  \`gumag cli search "<task>"\`, then read its inputs with
  \`gumag schema <command>\` (for example \`gumag schema swaps create\`).
- Every command prints JSON on stdout. Failures print
  \`{"error":{"code","message","details"}}\` on stderr and exit 1: branch on
  \`code\`, not on the message.
- \`gumag auth status\` shows which wallet signs and its USD limit. Keys stay
  on this machine; never print or commit them.
- Commands that sign (\`buy\`, \`sell\`, \`long\`, \`short\`, \`withdraw\`,
  \`swaps create\`, \`withdrawals create\`, \`perps orders create\`,
  \`perps close\`, \`perps orders cancel\`, \`perps deposit\`,
  \`perps withdraw\`, \`perps leverage set\`) stop with \`confirmation_required\`
  and the quote in \`details\` unless you pass \`--yes\`. Show that quote to
  the user and get their go-ahead before running it again with \`--yes\`.
- \`gumag buy <token> <usd>\`, \`gumag long <symbol> <usd>\` and
  \`gumag short <symbol> <usd>\` are sized in USD notional; use
  \`gumag perps orders create\` for base-unit sizing.
- Try anything that moves funds with \`--dry-run\` first: it quotes and signs,
  and the API checks the signature without executing anything.
- Set \`GUM_MAX_TRADE_USD\` (or \`gumag auth login --max-usd\`) so no single
  trade or withdrawal can exceed it.
- Follow a spot trade with \`gumag swaps watch <id>\` or
  \`gumag swaps get <id> --wait\`; it's done when \`final\` is true. Inspect
  Perps positions, resting orders and configured leverage with
  \`gumag perps positions\`, \`gumag perps orders list\` or
  \`gumag perps account get\`.
`;
