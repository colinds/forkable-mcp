// MCP server over stdio. The MCP client spawns this process and owns its lifecycle, so there's
// nothing to run manually. Stateless in spirit: the only durable state is the on-disk session,
// read per tool call.
//
// NOTE: stdout is the JSON-RPC wire — only ever log to stderr here.
// There is no HTTP listener; (re-)authenticate out of band with `bun run auth --chrome`.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerAllTools } from "./tools.ts";
import { type Config } from "./config.ts";
import { ForkableClient } from "@/net/client.ts";
import { provisionFromEnvIfNeeded } from "@/auth/ingest.ts";
import { createWriteGate } from "@/write-gate.ts";

/** Build a fresh MCP server with all tools registered (one per stdio connection). */
function makeServer(cfg: Config): McpServer {
  const server = new McpServer({ name: "forkable", version: cfg.version });
  registerAllTools(server, createWriteGate());
  return server;
}

/** Keep the Rails session warm and rotate cookies (~every 20 min). */
function startKeepalive(): void {
  setInterval(
    () => {
      ForkableClient.fromStore()
        .then((c) => c.warm())
        .catch(() => {});
    },
    20 * 60 * 1000,
  ).unref?.();
}

export async function runStdio(cfg: Config): Promise<void> {
  // Headless provisioning: if FORKABLE_COOKIE is set and there's no session yet, ingest it first
  // (best-effort — a failure just means tools return the re-auth message).
  const me = await provisionFromEnvIfNeeded().catch((e) => {
    console.error(`env auth failed: ${(e as Error).message}`);
    return null;
  });
  serveStdio(() => makeServer(cfg));
  console.error(
    `forkable-mcp v${cfg.version} on stdio${me ? ` (provisioned ${me.email ?? `user ${me.id}`} from env)` : ""}`,
  );
  startKeepalive();
}
