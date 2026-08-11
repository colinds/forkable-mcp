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

There's no API key — the server reuses a real Forkable web session. Authenticate once (re-run when
it expires) using **any one** of the four methods below. Pick 1 if your account has a password,
otherwise 2; 3 and 4 are the manual fallbacks.

*(From a clone, use `bun run auth …` in place of `bunx forkable-mcp --auth …` everywhere below.)*

### 1. Email + password — best if it works

Works headless, and it's the only method that **auto-refreshes**: on a 401 the server logs back in
and retries. Not available on SSO-only accounts (it fails fast and tells you).

```bash
bunx forkable-mcp --auth --login --email you@co.com --password '…'
# or set FORKABLE_EMAIL / FORKABLE_PASSWORD (+ FORKABLE_MFA) and run: bunx forkable-mcp --auth --login
```

### 2. Import from your browser — best for SSO (macOS only)

Log in to [forkable.com](https://forkable.com) in your browser, then let the CLI lift the session
cookie out of it. It decrypts the cookie via your login Keychain, so **macOS will prompt you to allow
access** — approve it.

```bash
bunx forkable-mcp --auth --chrome                      # Chrome
bunx forkable-mcp --auth --chrome --browser arc        # or brave, edge, vivaldi, opera, chromium,
                                                       # chrome-beta, chrome-dev, chrome-canary
```

**Multiple browser profiles?** All of them are searched and the one with the most recently used
Forkable session wins — the CLI prints which profile it picked. To pin one explicitly, pass the
profile *directory* name (not its display name):

```bash
bunx forkable-mcp --auth --chrome --browser arc --profile "Profile 1"
```

### 3. Paste the cookie header — works anywhere

Use this on Linux/Windows, or when method 2 can't find your profile.

1. Open [forkable.com](https://forkable.com) and log in.
2. Open DevTools (<kbd>⌥⌘I</kbd> / <kbd>F12</kbd>) → **Network** tab.
3. Reload the page, then click a request to the **GraphQL endpoint** — filter the list for `graphql`
   and pick one of the `POST https://forkable.com/api/v2/graphql` rows. (Those are the authenticated
   API calls, so they always carry the session cookie; a static asset or image request may not.)
4. In **Headers → Request Headers**, find the `cookie:` line and copy its whole value — it's a long
   `name=value; name=value; …` string, and it must include `_easyorder_session`.

```bash
FORKABLE_COOKIE='_easyorder_session=…; other=…' bunx forkable-mcp --auth
```

### 4. Paste a "Copy as cURL" blob — same thing, less clicking

**"Copy as cURL" is a built-in DevTools command.** Right-click any request in the Network tab and
choose **Copy → Copy as cURL**, and DevTools writes the entire request to your clipboard as a
ready-to-run `curl` command — URL, method, body, and every header, *including* the `cookie:` header.
That's the part we want; instead of hunting for the cookie line yourself, paste the whole blob and
the CLI parses the cookie out of it (everything else is ignored).

1. forkable.com → DevTools → **Network**, reload the page.
2. Filter for `graphql` and right-click a **`POST https://forkable.com/api/v2/graphql`** request →
   **Copy** → **Copy as cURL**. Use a GraphQL request specifically — it's an authenticated API call,
   so it's guaranteed to carry the session cookie.
   - Chrome/Edge/Arc: `Copy as cURL`; on Windows pick `Copy as cURL (bash)`.
   - Safari: `Copy as cURL`. Firefox: `Copy Value → Copy as cURL`.
3. Pipe the clipboard in:

```bash
pbpaste | bunx forkable-mcp --auth              # macOS
bunx forkable-mcp --auth --file ./forkable.curl  # or save it to a file first
```

What you paste looks like this (truncated) — the `-H 'cookie: …'` header is all that's read:

```
curl 'https://forkable.com/api/v2/graphql' \
  -H 'accept: application/json' \
  -H 'x-csrf-token: …' \
  -H 'cookie: _easyorder_session=abc123…; _ga=GA1.2…' \
  --data-raw '{"query":"…"}'
```

> [!NOTE]
> Methods 2–4 give a cookie that **can't be refreshed** — when it expires (or you log out in the
> browser) you'll get a re-auth message and need to re-run the import. Only method 1 self-heals.

The session is stored at `~/.forkable-mcp/session.json` (mode `0600`) and is never logged.

## Configuration

All settings are environment variables (`.env` is auto-loaded by Bun — see `.env.example`). Everything
is optional; with none set you authenticate interactively and there's no spend cap.

| Variable | Default | Description |
|---|---|---|
| `FORKABLE_EMAIL` | — | Email for headless password login. With `FORKABLE_PASSWORD`, also enables auto-relogin when the session expires. |
| `FORKABLE_PASSWORD` | — | Password for headless login (pair with `FORKABLE_EMAIL`). |
| `FORKABLE_MFA` | — | MFA code, if your account requires one for password login. |
| `FORKABLE_COOKIE` | — | Headless auth for SSO-only accounts: a full forkable.com Cookie header (see [Auth](#3-paste-the-cookie-header--works-anywhere)). Provisioned on startup if no session exists. |
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
