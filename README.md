# @gumag/cli

The GUM CLI (`gumag`) for people and agents, and a stdio MCP server. Its
commands are generated from the
[GUM Trading API](https://docs.gum.ag/trading-api/overview)'s OpenAPI spec,
print JSON, and sign locally with a wallet kept on your machine.

- Docs: https://docs.gum.ag/trading-api/cli
- OpenAPI spec: https://api.gum.ag/app/v1/openapi.json
- Website: https://gum.ag

## Quick start

```bash
npx @gumag/cli auth login                    # a bot wallet, saved per profile in ~/.config/gum
npx @gumag/cli buy SOL 5                     # spot buy ($5 USD): quote, confirm, sign, submit, wait
npx @gumag/cli long BTC 25                   # GUM Perps long ($25 USD notional)
npx @gumag/cli perps markets list            # list live perpetual markets & funding rates
npx @gumag/cli cli search "withdraw usdc"    # find the command for a task
npx @gumag/cli schema swaps create           # a command's inputs, typed
npx @gumag/cli mcp                           # MCP server over stdio
```

Needs Node.js 22 or later. `npm install -g @gumag/cli` installs two commands,
`gumag` and the shorter `gumx`, to use in place of `npx @gumag/cli`.

## Connect to MCP clients & AI agents

```bash
# Claude Code
claude mcp add gum -- npx -y @gumag/cli@latest mcp

# Install the GUM trading skill (Claude Code, Codex, Cursor, etc.)
npx skills add jupnet/gum-cli
```

## Design & safety guarantees

- Every command prints JSON: indented on a terminal, one line when piped or
  run by an agent. Failures are `{ "error": { "code", "message" } }` on stderr
  with exit code 1. A flag the command doesn't take is an error too, before
  anything is quoted or signed.
- Signing commands stop with `confirmation_required` (and the quote) unless
  `--yes` when nobody is at the terminal, and never sign above the lowest of
  `--max-usd`, `GUM_MAX_TRADE_USD` and the profile's limit.
- Use `swaps quote`, `withdrawals quote`, or `perps orders quote` for prices
  without signing. `--dry-run` (or MCP `dryRun: true`) on a signing command
  still signs locally and sends the signature for validation without executing
  (over MCP, a USD limit is still required).
- If submission succeeds but status polling fails, `status_unavailable` retains
  the accepted ID, initial status, original error, and a read-only command in
  `error.details.recovery.command`. Keep the same environment when running it.
  Do not repeat the signed command. When the submit itself fails in a way that
  may still have gone through (a timeout, a lost connection, a server error
  or an unreadable reply), `error.details.retrySubmission` is `false`: check
  `gumag history list` before trying again.
- Keys come from `GUM_SOLANA_SECRET_KEY` or `GUM_EVM_PRIVATE_KEY`, else the
  profile's key (`auth login`). `--network devnet` or `GUM_API_URL` point at
  another API; the default is `https://api.gum.ag/app/v1`. gumag signs the
  transactions that API builds, so point it only at an API you trust.
- The MCP server is hand-written JSON-RPC over stdio rather than the MCP SDK,
  so `npx` installs two small dependencies and starts fast.

## Security

See [SECURITY.md](./SECURITY.md) for the local-signing security model and how to
report vulnerabilities privately.

## License

MIT
