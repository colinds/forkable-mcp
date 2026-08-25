# forkable-mcp

[![npm](https://img.shields.io/npm/v/forkable-mcp.svg)](https://www.npmjs.com/package/forkable-mcp)
[![CI](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/colinds/forkable-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black.svg)](https://modelcontextprotocol.io)
[![Runtime: Bun or Node](https://img.shields.io/badge/runtime-Bun%20or%20Node-fbf0df.svg)](https://bun.sh)

Order and manage your [Forkable](https://forkable.com) lunches from Claude, Codex, Cursor, or another
MCP client. You can see your week, browse menus, get recommendations, change meals, and check where
lunch is without opening the Forkable app.

> [!WARNING]
> This is an unofficial project and is not affiliated with Forkable. It uses your Forkable web
> session and an undocumented API that may change.

## Features

- See upcoming deliveries and the meals already selected
- Track courier ETAs, arrival times, and office access notes
- Browse and search menus
- Get Forkable's meal recommendations
- Add, replace, remove, skip, and confirm meals
- Use it from any MCP client that can launch a stdio server

## Quick start

You need [Bun](https://bun.sh) or Node.

First, log in to Forkable in Chrome and import that session:

```bash
bunx --bun forkable-mcp@latest --auth --chrome # Node: npx forkable-mcp@latest --auth --chrome
```

Then add it to your MCP client:

| Client                   | Command or configuration                                    |
| ------------------------ | ----------------------------------------------------------- |
| Claude Code              | `claude mcp add forkable -- bunx --bun forkable-mcp@latest` |
| Codex                    | `codex mcp add forkable -- bunx --bun forkable-mcp@latest`  |
| Claude Desktop or Cursor | Add the JSON below under `mcpServers`                       |
| VS Code                  | Add the JSON below under `servers` in `.vscode/mcp.json`    |

```json
{
  "mcpServers": {
    "forkable": {
      "command": "bunx",
      "args": ["--bun", "forkable-mcp@latest"]
    }
  }
}
```

Restart or reconnect your client, then ask something like:

> What's for lunch this week?

## Skills

Three [agent skills](https://agentskills.io) ship with the server:

- `forkable` contains the shared instructions for meals, deliveries, and tool use
- `forkable-friday` adds a week-ahead planning routine on top of `forkable`
- `forkable-setup` covers installation and authentication

Install them with:

```bash
npx skills add colinds/forkable-mcp
npx skills add colinds/forkable-mcp --list # See what's included first
```

The source files are in [`skills/`](./skills).

## Tools

| Tool                  | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `list_deliveries`     | Shows upcoming deliveries and selected meals                       |
| `get_delivery_status` | Shows courier status, ETA, arrival time, tracking, and access notes |
| `get_menus`           | Lists menus and item options for a delivery                         |
| `search_items`        | Searches a delivery's menus                                        |
| `recommend_meals`     | Returns Forkable's meal recommendations                            |
| `explain_pick`        | Shows where the current meal appears in Forkable's recommendations |
| `get_profile`         | Shows the signed-in Forkable user                                  |
| `set_meal`            | Adds or replaces a meal                                            |
| `set_meal_all`        | Sets the same meal on several deliveries                           |
| `remove_meal`         | Removes a meal                                                     |
| `skip_delivery`       | Skips a delivery                                                   |
| `confirm_delivery`    | Confirms or unconfirms a delivery                                  |

Forkable still decides whether a change is allowed, including deadlines, restaurant capacity, and
billing rules.

## Authentication

There is no API key. The server reuses a Forkable web session and stores it in
`~/.forkable-mcp/session.json`.

### Import from a browser

Log in at [forkable.com](https://forkable.com), then run:

```bash
bunx --bun forkable-mcp@latest --auth --chrome # Node: npx forkable-mcp@latest --auth --chrome
```

Chrome and Edge profiles are found automatically on macOS, Linux, and Windows. Browser import is
best-effort because browser storage and operating-system security rules vary.

On macOS, Keychain may ask for permission once per browser profile. Limit the scan if you know which
profile you use:

```bash
bunx --bun forkable-mcp@latest --auth --chrome --profile "Profile 1"
```

Arc is supported on macOS:

```bash
bunx --bun forkable-mcp@latest --auth --chrome --browser arc
```

Brave and Chromium are also supported. On Linux or Windows, you may need to pass a profile directory
or cookie database with `--profile`.

### Email and password

```bash
bunx --bun forkable-mcp@latest --auth --login --email you@example.com # Node: npx forkable-mcp@latest --auth --login --email you@example.com
```

The command asks for your password without showing it. Password-based sessions can sign in again
after they expire. SSO-only accounts need a browser or cookie import instead.

For non-interactive use, send the password on standard input with `--password-stdin`, or set
`FORKABLE_EMAIL` and `FORKABLE_PASSWORD`.

### Copy as cURL

If browser import cannot find your session, copy an authenticated Forkable GraphQL request from your
browser's developer tools:

1. Open Forkable, then open Developer Tools and select **Network**.
2. Reload the page and filter for `graphql`.
3. Right-click a request to `/api/v2/graphql` and choose **Copy as cURL**.
4. Pipe the copied command into the auth command:

```bash
pbpaste | bunx --bun forkable-mcp@latest --auth # Node: pbpaste | npx forkable-mcp@latest --auth
```

Only the Cookie header is imported. You can also save the copied command and pass it with
`--file ./forkable.curl`, or set `FORKABLE_COOKIE` to the full Cookie header.

Cookie-based sessions cannot refresh themselves. Import the cookie again when it expires.

## Configuration

All settings are optional. Bun reads `.env` automatically; with Node, set them in the MCP server's
environment.

| Variable             | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `FORKABLE_EMAIL`     | Email for non-interactive login and session refresh            |
| `FORKABLE_PASSWORD`  | Password used with `FORKABLE_EMAIL`                            |
| `FORKABLE_MFA`       | MFA code for password login                                    |
| `FORKABLE_COOKIE`    | Full Forkable Cookie header for headless or SSO authentication |
| `FORKABLE_CSRF`      | Sets the initial CSRF token; normally unnecessary              |
| `FORKABLE_MAX_TOTAL` | Local per-meal spending limit in dollars                       |
| `FORKABLE_MCP_HOME`  | Changes where the session is stored                            |

`FORKABLE_MAX_TOTAL` is a local limit, not a Forkable allowance or billing rule. Billing information
is shown as Forkable reports it.

## From source

```bash
bun install
bun run auth --chrome
bun run start
```

## Development

```bash
bun test
bun run test:tz
bun run check
bun run smoke
```

## License

[MIT](./LICENSE) © Colin D'Souza
