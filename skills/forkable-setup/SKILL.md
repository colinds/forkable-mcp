---
name: forkable-setup
description: >-
  Install, authenticate, and register forkable-mcp — the MCP server for Forkable corporate lunch —
  with Claude Code, Codex, Cursor, Claude Desktop, or VS Code. Use when the Forkable tools aren't
  connected yet, when a call comes back needing re-authentication, or when the user asks to set up
  or reconnect Forkable.
---

# Setting up forkable-mcp

Unofficial MCP server for [Forkable](https://forkable.com): <https://github.com/colinds/forkable-mcp>.
It acts on the user's behalf with their own Forkable session — there is no API key.

**Check first.** If `list_deliveries` and friends already answer, it's set up; stop here and use the
`forkable-lunch` skill. If a call fails with a re-auth message, redo step 1 alone — the session
expired, nothing needs reinstalling.

Requires [Bun](https://bun.sh) 1.3+ (`bun --version`). `bunx` runs the server; there's nothing to
clone or install globally.

## 1. Authenticate — the user runs this themselves

These commands take their password or unlock their macOS Keychain, so hand them the line to run in a
real terminal rather than running it for them. Never put their password in a
command you execute or in a file you write.

**macOS, already logged into Forkable in a browser:**

```bash
bunx forkable-mcp@latest --auth --chrome
```

Approve the Keychain prompt. Every Chrome profile is searched and the most recently used Forkable
session wins. Other browsers: `--browser arc` (also brave, edge, vivaldi, opera, chromium,
chrome-beta, chrome-dev, chrome-canary); pin a profile by its *directory* name with
`--profile "Profile 1"`.

**Email + password** — the only method that survives expiry (the server re-logs in on a 401):

```bash
bunx forkable-mcp@latest --auth --login --email you@company.com --password '…'
```

Add `--mfa <code>` if their account asks for one. A password typed as an argument lands in shell
history — `FORKABLE_EMAIL` / `FORKABLE_PASSWORD` in the environment does the same job without that.

**SSO / Okta accounts can't use password login** and the command says so immediately. Those need a
cookie: forkable.com → DevTools → Network → filter `graphql` → right-click a `POST .../api/v2/graphql`
row → *Copy → Copy as cURL*, then `pbpaste | bunx forkable-mcp@latest --auth`. The whole blob is
fine; only the `cookie:` header is read, and it must contain `_easyorder_session`. Cookie sessions
can't self-refresh — expect to repeat this when it expires.

The session lands in `~/.forkable-mcp/session.json` (mode `0600`) and is never logged.

## 2. Register the server

| Client | Command / config |
|---|---|
| Claude Code | `claude mcp add forkable -- bunx forkable-mcp@latest` |
| Codex | `codex mcp add forkable -- bunx forkable-mcp@latest` |
| Claude Desktop / Cursor | the JSON below, under `mcpServers` |
| VS Code | the JSON below in `.vscode/mcp.json`, under `servers` |

```json
{
  "mcpServers": {
    "forkable": { "command": "bunx", "args": ["forkable-mcp@latest"] }
  }
}
```

Add `-g` / `--scope user` if the user wants it in every project rather than this one.

## 3. Restart the client and verify

The client spawns the server at startup, so a restart is required before the tools appear. Then call
`get_profile` — it should name the authenticated user. Now use the `forkable-lunch` skill.

## Optional environment

All optional; set them in the client's MCP config `env` block, not in the shell.

| | |
|---|---|
| `FORKABLE_EMAIL` / `FORKABLE_PASSWORD` | headless login, and auto-relogin when the session expires |
| `FORKABLE_MAX_TOTAL` | hard spend cap in dollars — a write over it is refused outright |
| `FORKABLE_COOKIE` | a full Cookie header, for headless SSO accounts |
| `FORKABLE_MCP_HOME` | where the session lives (default `~/.forkable-mcp`) |

## Troubleshooting

- **Tools missing after install** — the client wasn't restarted, or the config went in the wrong file.
- **Upgraded, but the behavior didn't change** — the client spawned the server at startup and a new
  npm version doesn't restart it; env changes are read at startup too. Reconnect the server (`/mcp`
  in Claude Code) or restart the client, and keep `@latest` in the command — bunx won't update on
  its own.
- **`bunx: command not found`** — Bun isn't installed: `curl -fsSL https://bun.sh/install | bash`.
- **Re-auth message on a tool call** — the session expired. Re-run step 1; only password logins heal
  themselves.
- **Browser import finds nothing** — they're not logged in at forkable.com in that browser, or it's a
  profile the search missed. Log in, retry, or fall back to the cURL paste.
