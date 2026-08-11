# forkable-mcp

[![npm](https://img.shields.io/npm/v/forkable-mcp.svg)](https://www.npmjs.com/package/forkable-mcp)
[![CI](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-fbf0df.svg)](https://bun.sh)

Order and manage your [Forkable](https://forkable.com) corporate lunches from Claude, Cursor, or any MCP
client. See your week, browse and search menus, get personalized picks, and set / skip / confirm meals —
all from chat.

> [!WARNING]
> Unofficial, not affiliated with Forkable. It acts on your behalf using your own Forkable session.
> Use your own account, at your own risk.

## Features

- 📅 See upcoming deliveries — status, cutoff, copay, and what's already picked
- 🍱 Browse and search menus, and get personalized meal recommendations
- ✏️ Set, batch-set, remove, skip, and confirm meals
- 🤖 Runs over stdio (your client launches it); headless-friendly for agents

## Quick start

Requires [Bun](https://bun.sh) 1.3+ (`bunx` runs it — no clone needed).

**1. Authenticate** (imports your logged-in browser session on macOS; see [Auth](#auth) for other options)

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
| 📅 | `list_deliveries` | Upcoming deliveries: date, status, what's picked, editing cutoff, copay |
| 🍱 | `get_menus` | Items for a delivery (pass `itemId` for one item's modifiers/options) |
| 🔎 | `search_items` | Keyword search across a delivery's menus |
| ✨ | `recommend_meals` / `explain_pick` | Personalized picks, and why the current meal was chosen |
| 👤 | `get_profile` | The authenticated user |
| ✅ | `set_meal` / `set_meal_all` | Set the meal for a day (or several days at once) |
| ➖ | `remove_meal` / `skip_delivery` | Remove a meal, or skip a whole day |
| 🔒 | `confirm_delivery` | Confirm (or unconfirm) a delivery |

## Auth

There's no API key: the server reuses a real Forkable web session. Pick one of the four below. From a clone,
use `bun run auth …` in place of `bunx forkable-mcp --auth …`.

### Email + password

```bash
bunx forkable-mcp --auth --login --email you@co.com --password '…'
# or set FORKABLE_EMAIL / FORKABLE_PASSWORD (+ FORKABLE_MFA), then: bunx forkable-mcp --auth --login
```

The only method that survives expiry: on a 401 the server logs back in and retries. SSO-only accounts
can't use it and fail fast with a message saying so. The cookie methods below cover those, but you have
to re-run them whenever the session expires.

### Import from your browser (macOS)

Log in at [forkable.com](https://forkable.com), then pull the cookie out of the browser. Decrypting it
needs your login Keychain, so approve the macOS prompt when it appears.

```bash
bunx forkable-mcp --auth --chrome
bunx forkable-mcp --auth --chrome --browser arc    # brave, edge, vivaldi, opera, chromium,
                                                   # chrome-beta, chrome-dev, chrome-canary
```

Every profile is searched and the most recently used Forkable session wins; the CLI prints which one
it picked. Pin a specific profile with its *directory* name, not its display name:
`--profile "Profile 1"`.

### Copy as cURL

"Copy as cURL" is a DevTools command: right-click a request in the Network tab, pick **Copy → Copy as
cURL**, and DevTools puts that entire request on your clipboard as a runnable `curl` — URL, body, and
every header, cookie included. Paste the whole thing; only the `cookie:` header is read.

1. forkable.com → DevTools (<kbd>⌥⌘I</kbd> / <kbd>F12</kbd>) → **Network**, reload the page.
2. Filter for `graphql`, right-click a `POST https://forkable.com/api/v2/graphql` row → **Copy → Copy
   as cURL**. Use a GraphQL request, since those are authenticated calls and always carry the session.
   (Windows: `Copy as cURL (bash)`. Firefox: `Copy Value → Copy as cURL`.)
3. `pbpaste | bunx forkable-mcp --auth`, or save it and use `--file ./forkable.curl`.

What lands on your clipboard, truncated:

```
curl 'https://forkable.com/api/v2/graphql' \
  -H 'accept: application/json' \
  -H 'x-csrf-token: …' \
  -H 'cookie: _easyorder_session=abc123…; _ga=GA1.2…' \
  --data-raw '{"query":"…"}'
```

### Paste the cookie header

Same idea, one header instead of the whole blob. Useful on Linux/Windows, or when the browser import
can't find your profile. Follow steps 1–2 above, but click the request instead of right-clicking it,
then copy the whole `cookie:` value under **Headers → Request Headers**. It's a long
`name=value; name=value; …` string and must contain `_easyorder_session`.

```bash
FORKABLE_COOKIE='_easyorder_session=…; other=…' bunx forkable-mcp --auth
```

The session is stored at `~/.forkable-mcp/session.json` (mode `0600`) and is never logged.

## Configuration

All settings are environment variables (`.env` is auto-loaded by Bun — see `.env.example`). Everything
is optional; with none set you authenticate interactively and there's no spend cap.

| Variable | Default | Description |
|---|---|---|
| `FORKABLE_EMAIL` | — | Email for headless password login. With `FORKABLE_PASSWORD`, also enables auto-relogin when the session expires. |
| `FORKABLE_PASSWORD` | — | Password for headless login (pair with `FORKABLE_EMAIL`). |
| `FORKABLE_MFA` | — | MFA code, if your account requires one for password login. |
| `FORKABLE_COOKIE` | — | Headless auth for SSO-only accounts: a full forkable.com Cookie header (see [Auth](#paste-the-cookie-header)). Provisioned on startup if no session exists. |
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
