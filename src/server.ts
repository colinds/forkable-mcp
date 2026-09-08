// MCP over stdio. Stdout is reserved for JSON-RPC; diagnostics must use stderr.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerAllTools } from "./tools.ts";
import pkg from "../package.json" with { type: "json" };
import { ForkableClient } from "@/net/client.ts";
import { provisionFromEnvIfNeeded } from "@/auth/ingest.ts";
import { createWriteGate } from "@/write-gate.ts";

/** Build a fresh MCP server with all tools registered (one per stdio connection). */
function makeServer(): McpServer {
  const server = new McpServer({ name: "forkable", version: pkg.version });
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

export async function runStdio(): Promise<void> {
  // Best-effort session provisioning from environment credentials.
  const me = await provisionFromEnvIfNeeded().catch((e) => {
    console.error(`env auth failed: ${(e as Error).message}`);
    return null;
  });
  serveStdio(makeServer);
  console.error(
    `forkable-mcp v${pkg.version} on stdio${me ? ` (provisioned ${me.email ?? `user ${me.id}`} from env)` : ""}`,
  );
  startKeepalive();
}
