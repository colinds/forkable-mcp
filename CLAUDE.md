# CLAUDE.md

Architecture and development notes for **forkable-mcp**. User-facing quick start is in the [README](./README.md).

## What it is

A local, stateless MCP server (Bun + TypeScript) that drives a Forkable corporate-lunch account over
**stdio**. The MCP client spawns the process and owns its lifecycle; the only durable state is an
on-disk session, read on every tool call.

## Project layout

```
src/
  index.ts        entry: argv → stdio server, or `--auth` CLI
  config.ts       env → Config
  server.ts       serveStdio + keepalive + headless env provisioning
  tools.ts        the 11 tool definitions + shared runtime helpers
  write-gate.ts   preview-then-token write safety
  net/            Forkable transport
    endpoints.ts    URLs, headers, User-Agent
    client.ts       ForkableClient — query/mutate, CSRF, cookie rotation, 401 handling
    gql.ts          literal serializer + query/mutation builders
    errors.ts       error types
  auth/
    session.ts      on-disk session store (mode 0600)
    cookies.ts      cookie-jar merge + cURL parsing
    ingest.ts       normalize creds → verify → persist (+ FORKABLE_COOKIE provisioning)
    chrome.ts       macOS Chrome cookie decryption
    cli.ts          `bun run auth`
  order/            ordering domain (pure)
    types.ts        Menu / MenuItem / MenuModifier / Piece / Order / Delivery
    selections.ts   selectionsHash builder
    guards.ts       ordering guards
    format.ts       money / date formatting
tests/            bun test
```

## Transport

stdio via `serveStdio` from `@modelcontextprotocol/server`. `index.ts` defaults to it; there is no
HTTP server. Each tool reads the session per call, so nothing is held in memory between requests.

## Auth

Forkable uses a session cookie plus a CSRF token (fetched automatically) — there's no API key. Establish
a session one of:

- **Email/password** (`auth/login.ts`): `bun run auth --login` (`--email`/`--password`/`--mfa`) or
  `FORKABLE_EMAIL`/`FORKABLE_PASSWORD` (+ `FORKABLE_MFA`) env. Logs in via the `createSession` mutation;
  works headless. A public `identities` pre-check fails fast on SSO-only accounts. Password-capable only.
- **Browser cookie**: `bun run auth --chrome` (macOS Keychain-decrypts the local browser cookie; `--browser`
  picks chrome / brave / edge / arc / vivaldi / opera / chromium / chrome-beta), `FORKABLE_COOKIE` env, or
  `bun run auth --file <path>` / `pbpaste | bun run auth`.

On startup with no session, `provisionFromEnvIfNeeded` establishes one from env (cookie first, else
email/password). The session is stored at `~/.forkable-mcp/session.json` (mode `0600`, never logged); the
client mints CSRF on demand, persists rotated cookies, and a ~20-min keepalive keeps it warm. On a `401`:
if `FORKABLE_EMAIL`/`FORKABLE_PASSWORD` are set, `guard()` **auto-relogins and retries once** (self-healing);
otherwise it returns a re-auth message (a pasted cookie can't be refreshed without a browser).

## Write safety (preview-then-token)

Write tools are dry-run by default. A call returns the exact mutation, the resolved variables, a summary,
and an HMAC `confirmToken` bound to a canonical serialization of the payload — **nothing is sent**.
Calling the tool again with that token re-derives the HMAC over the payload rebuilt from live data and
sends only on a match, so any drift (price, cutoff, the piece being replaced) invalidates it. Blocking
guards (past cutoff, over capacity, a required modifier missing, no late orders left) never mint a token.

## selectionsHash

The customization payload for a meal item — keyed by modifier id → array of selected option ids:

- single-select modifier (`max === 1 && options.length > 1`): `[optionId]`, or `[-1]` when a
  non-required single-select has nothing chosen
- multi-select: the array of chosen option ids
- key order follows the item's `modifierIds` (stable + diffable)

Required modifiers default to the first diet-safe option. `set_meal` includes hidden modifiers so their
defaults are still sent. Item ids are **not** unique across a delivery's menus, so items are always
resolved by `(menuId, itemId)`.

## Money & dates

API money is **dollars** (floats), rendered by `formatMoney`. The default `from` date uses the local
calendar day (`todayLocal`) to avoid a UTC off-by-one near midnight.

## Environment variables

| Variable | Purpose |
|---|---|
| `FORKABLE_EMAIL` / `FORKABLE_PASSWORD` | Headless email/password login; also enables auto-relogin on 401. |
| `FORKABLE_MFA` | Optional MFA code for password login. |
| `FORKABLE_COOKIE` | Headless auth: a full Cookie header, provisioned on startup if no session exists. |
| `FORKABLE_CSRF` | Optional CSRF token to pin (otherwise fetched automatically). |
| `FORKABLE_WRITE_SECRET` | Optional HMAC key for confirm-tokens (else a per-install key is generated and stored). |
| `FORKABLE_MCP_HOME` | Session store directory (default `~/.forkable-mcp`). |

## Development

```bash
bun test          # unit tests (selectionsHash round-trip, confirm-token, guards, serializer, crypto)
bun run check     # oxlint + oxfmt --check + tsc + bun test
bun run fmt       # oxfmt --write
```

Conventions: delivery-scoped tools take `deliveryId` first; reads are `get_/list_/search_/recommend_/
explain_`, writes are `set_/remove_/skip_/confirm_`, and every write takes an optional `confirmToken`.
TypeScript 7 strict, 2-space indent, kebab-case filenames, snake_case tool names.
