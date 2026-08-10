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

**1. Clone and install**

```bash
git clone https://github.com/colinds/forkable-mcp.git
cd forkable-mcp && bun install
```

**2. Authenticate** (imports your logged-in browser session on macOS — see [Auth](#auth) for other options)

```bash
bun run auth --chrome
```

**3. Add it to your MCP client** (replace `/path/to/forkable-mcp` with your clone):

| Client | Add it |
|---|---|
| Claude Code | `claude mcp add forkable -- bun run --cwd /path/to/forkable-mcp start` |
| Codex | `codex mcp add forkable -- bun run --cwd /path/to/forkable-mcp start` |
| Claude Desktop / Cursor | add the JSON below to the config (under `mcpServers`) |
| VS Code | add the JSON below to `.vscode/mcp.json` (under `servers`) |

```json
{
  "mcpServers": {
    "forkable": { "command": "bun", "args": ["run", "--cwd", "/path/to/forkable-mcp", "start"] }
  }
}
```

Then ask your client things like *"what's for lunch this week?"* or *"set Tuesday to the chicken bowl."*

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
bun run auth --login --email you@co.com --password …   # or set FORKABLE_EMAIL / FORKABLE_PASSWORD (+ FORKABLE_MFA)
```

**Browser cookie** — use this for SSO-only accounts:

- `bun run auth --chrome` — from your logged-in browser on macOS (`--browser brave|edge|arc|…`)
- `FORKABLE_COOKIE='_easyorder_session=…; …'` — headless (env)
- `pbpaste | bun run auth` — paste a DevTools "Copy as cURL"

The session is stored at `~/.forkable-mcp/session.json` and is never logged.

## Config & development

Env (`.env`, see `.env.example`): `FORKABLE_COOKIE`, `FORKABLE_MAX_TOTAL` (hard spend cap),
`FORKABLE_WRITE_SECRET`, `FORKABLE_MCP_HOME`.

```bash
bun test          # unit tests
bun run check     # lint + format + typecheck + test
```

## License

[MIT](./LICENSE) © Colin D'Souza
