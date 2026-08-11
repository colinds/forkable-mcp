# forkable-mcp

[![CI](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-fbf0df.svg)](https://bun.sh)

Order and manage your [Forkable](https://forkable.com) corporate lunches from Claude, Cursor, or any MCP
client. See your week, browse and search menus, get personalized picks, and set / skip / confirm meals —
all from chat.

> [!WARNING]
> Unofficial, not affiliated with Forkable. It acts on your behalf using your own Forkable session — use
> your own account, at your own risk.

## Features

- 📅 See upcoming deliveries — status, cutoff, copay, and what's already picked
- 🍱 Browse and search menus, and get personalized meal recommendations
- ✏️ Set, batch-set, remove, skip, and confirm meals
- 🤖 Runs over stdio (your client launches it); headless-friendly for agents

## Quick start

Requires [Bun](https://bun.sh) 1.3+ (`bunx` runs it — no clone needed).

**1. Authenticate** (imports your logged-in browser session on macOS — see [Auth](#auth) for other options)

```bash
bunx forkable-mcp --auth --chrome
```

**2. Add it to your MCP client**

| Client | Add it |
|---|---|
| Claude Code | `claude mcp add forkable -- bunx forkable-mcp` |
| Codex | `codex mcp add forkable -- bunx forkable-mcp` |
| Claude Desktop / Cursor | add the JSON below to the config (under `mcpServers`) |
| VS Code | add the JSON below to `.vscode/mcp.json` (under `servers`) |

```json
{
  "mcpServers": {
    "forkable": { "command": "bunx", "args": ["forkable-mcp"] }
  }
}
```

Then ask your client things like *"what's for lunch this week?"* or *"set Tuesday to the chicken bowl."*

> **From source instead?** `git clone` + `bun install`, authenticate with `bun run auth --chrome`, and
> point your client at `bun run --cwd /path/to/forkable-mcp start`.

## Tools

| | Tool | Does |
|---|---|---|
| 📅 | `list_deliveries` | Upcoming deliveries: date, status, what's picked, cutoff, copay |
| 🍱 | `get_menus` | Items for a delivery (pass `itemId` for one item's modifiers/options) |
| 🔎 | `search_items` | Keyword search across a delivery's menus |
| ✨ | `recommend_meals` / `explain_pick` | Personalized picks, and why the current meal was chosen |
| 👤 | `get_profile` | The authenticated user |
| ✅ | `set_meal` / `set_meal_all` | Set the meal for a day (or several days at once) |
| ➖ | `remove_meal` / `skip_delivery` | Remove a meal, or skip a whole day |
| 🔒 | `confirm_delivery` | Confirm (or unconfirm) a delivery |

## Auth

There's no API key. Authenticate once (re-run when the session expires) one of these ways:

**Email / password** — works headless and **auto-refreshes** on expiry (for accounts that allow password login):

```bash
bunx forkable-mcp --auth --login --email you@co.com --password …   # or set FORKABLE_EMAIL / FORKABLE_PASSWORD (+ FORKABLE_MFA)
```

**Browser cookie** — use this for SSO-only accounts:

- `bunx forkable-mcp --auth --chrome` — from your logged-in browser on macOS (`--browser brave|edge|arc|…`)
- `FORKABLE_COOKIE='_easyorder_session=…; …'` — headless (env)
- `pbpaste | bunx forkable-mcp --auth` — paste a DevTools "Copy as cURL"

(From a clone, use `bun run auth …` in place of `bunx forkable-mcp --auth …`.)

The session is stored at `~/.forkable-mcp/session.json` and is never logged.

## Configuration

All settings are environment variables (`.env` is auto-loaded by Bun — see `.env.example`). Everything
is optional; with none set you authenticate interactively and there's no spend cap.

| Variable | Default | Description |
|---|---|---|
| `FORKABLE_EMAIL` | — | Email for headless password login. With `FORKABLE_PASSWORD`, also enables auto-relogin when the session expires. |
| `FORKABLE_PASSWORD` | — | Password for headless login (pair with `FORKABLE_EMAIL`). |
| `FORKABLE_MFA` | — | MFA code, if your account requires one for password login. |
| `FORKABLE_COOKIE` | — | Headless auth for SSO-only accounts: a full forkable.com Cookie header. Provisioned on startup if no session exists. |
| `FORKABLE_CSRF` | — | Pin a CSRF token instead of the auto-fetched one (rarely needed). |
| `FORKABLE_MAX_TOTAL` | — | Hard spend cap in dollars: a write whose total exceeds it is refused (no confirm-token). Unset = no cap; the preview just notes when a meal is over your company's daily coverage. |
| `FORKABLE_WRITE_SECRET` | per-install | HMAC key for write confirm-tokens. Auto-generated and stored in the session file if unset; set it to pin one across machines. |
| `FORKABLE_MCP_HOME` | `~/.forkable-mcp` | Directory for the on-disk session (mode `0600`). |

## Development

```bash
bun test          # unit tests
bun run check     # lint + format + typecheck + test
```

## License

[MIT](./LICENSE) © Colin D'Souza
