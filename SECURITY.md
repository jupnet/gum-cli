# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately via GitHub Security Advisories:

- https://github.com/jupnet/gum-cli/security/advisories/new

Include reproduction steps, affected versions, and impact. We will acknowledge
reports promptly and coordinate a fix before public disclosure.

## Supported Versions

Security fixes are released on the latest `0.x` release of `@gumag/cli`.

## Security Model

`@gumag/cli` (`gumag`) signs transactions locally with your Solana or EVM
private key before submitting them to the GUM Trading API. Keep these
boundaries in mind:

- **Key isolation:** Keys are stored under `~/.config/gum/keys` (`0700`
  directory, `0600` file) or supplied via `GUM_SOLANA_SECRET_KEY` /
  `GUM_EVM_PRIVATE_KEY`. MCP tool calls never return raw key material or local
  key file paths, but any AI agent with shell access on the same machine can
  read files owned by your OS user. Fund bot wallets only with what you are
  willing to let the agent spend.
- **Spend limits:** Signing commands enforce the lowest of `--max-usd`,
  `GUM_MAX_TRADE_USD`, and the profile's saved `maxTradeUsd`. Over MCP, all
  signed write tools — including `dryRun: true`, which still signs transaction
  bytes locally — require a configured USD limit. Use unsigned quote tools
  (`quote`, `quote_withdrawal`, `quote_perps_order`) to inspect prices without
  signing.
- **Trusted API endpoint:** `gumag` signs transactions built by the configured
  API (`https://api.gum.ag/app/v1` by default). Non-loopback endpoints must use
  `https://`, HTTP redirects are refused, and terminal confirmations warn before
  signing for non-`gum.ag` hosts. Only set `GUM_API_URL` to an endpoint you
  trust.
- **Token resolution:** Symbol lookups only auto-select a lone verified token;
  unverified or ambiguous tokens require an explicit token address (and chain
  ID where applicable).
