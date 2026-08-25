#!/usr/bin/env node
// Entry modes:
//   `bun run src/index.ts --auth [--chrome|--file <path>]`  → import a session, then exit.
//   `bun run src/index.ts`                                  → serve MCP over stdio (client-spawned).

import { runStdio } from "./server.ts";
import { loadConfig } from "./config.ts";
import { runAuthCli } from "@/auth/cli.ts";

const argv = process.argv.slice(2);
if (argv.includes("--auth")) {
  await runAuthCli(argv);
} else {
  await runStdio(loadConfig());
}
