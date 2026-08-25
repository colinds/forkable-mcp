---
name: forkable-setup
description: >-
  Install, authenticate, and register forkable-mcp with an MCP client. Use when Forkable tools are
  unavailable, authentication has expired, or the user asks to connect or reconnect Forkable.
---

# Set up forkable-mcp

`forkable-mcp` is an unofficial MCP server that uses the user's Forkable web session. It does not
use an API key. Use Bun or Node.

If `get_profile` or `list_deliveries` already works, setup is complete. For an authentication
error, repeat only the authentication step.

Authentication handles account credentials or may unlock the operating system's credential store.
Give the command to the user to run in a terminal. Do not place a password in command-line arguments
or write it to a file.

## Authenticate

Choose one method.

### Import a browser session

The user must already be signed in at forkable.com:

```bash
bunx --bun forkable-mcp@latest --auth --chrome # Node: npx forkable-mcp@latest --auth --chrome
```

Browser import is best-effort on macOS, Linux, and Windows. On macOS, Keychain may prompt once per
scanned profile; use `--profile` to limit the scan. Linux may use its system keyring. Chrome and Edge
profiles are discovered automatically. Arc targeting is macOS-only; Brave and Chromium on Linux or
Windows may need an explicit profile path. Other supported browsers can be selected with `--browser`,
for example:

```bash
bunx --bun forkable-mcp@latest --auth --chrome --browser arc --profile "Profile 1"
```

Supported browser names are Chrome, Arc, Brave, Edge, and Chromium. The profile can be selected by
name or path.

### Email and password

```bash
bunx --bun forkable-mcp@latest --auth --login --email you@example.com
```

The terminal prompts for the password without echoing it. For non-interactive use, pass the password
on standard input with `--password-stdin`, or set `FORKABLE_EMAIL` and `FORKABLE_PASSWORD`. Use
`--mfa <code>` or `FORKABLE_MFA` when required.

Password login can refresh an expired session. SSO-only accounts require a cookie method.

### Import a cookie

Copy an authenticated Forkable GraphQL request as cURL in browser developer tools and pipe it to the
auth command:

```bash
pbpaste | bunx --bun forkable-mcp@latest --auth
```

The command reads only the Cookie header. A saved cURL request can be supplied with
`--file ./forkable.curl`. For headless use, set `FORKABLE_COOKIE` to the full Cookie header.
Cookie sessions must be imported again after they expire.

The session is stored at `~/.forkable-mcp/session.json` with mode `0600`.

## Register the server

| Client                   | Configuration                                               |
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

Restart or reconnect the MCP client, then call `get_profile` to verify the session.

## Optional environment variables

Set these in the MCP server's environment when needed:

| Variable                                 | Purpose                                               |
| ---------------------------------------- | ----------------------------------------------------- |
| `FORKABLE_EMAIL` and `FORKABLE_PASSWORD` | Non-interactive login and session refresh             |
| `FORKABLE_MFA`                           | MFA code for password login                           |
| `FORKABLE_COOKIE`                        | Full Cookie header for headless or SSO authentication |
| `FORKABLE_CSRF`                          | Explicit CSRF token; normally unnecessary             |
| `FORKABLE_MAX_TOTAL`                     | Local per-meal preview ceiling in dollars             |
| `FORKABLE_MCP_HOME`                      | Session directory; defaults to `~/.forkable-mcp`      |

## Continue with Forkable

After `get_profile` succeeds, use the `forkable` skill for meal, delivery, confirmation, and recovery
rules. Use `forkable-friday` with it when planning the next week.

## Troubleshooting

- If tools are missing, restart the client and check the MCP configuration location.
- If an upgrade is not visible, reconnect the server process so `bunx --bun ...@latest` starts again.
- If authentication expired, repeat the selected authentication method. Password-based sessions can
  refresh automatically; cookie sessions cannot.
- If browser import finds nothing, confirm that forkable.com is signed in in the selected browser
  profile, then retry or use a cookie method.
- If `bunx` is unavailable, install Bun from [bun.sh](https://bun.sh).
