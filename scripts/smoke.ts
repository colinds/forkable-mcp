#!/usr/bin/env bun
// Packaged-install smoke test: pack the tarball, install it into a scratch project, and drive the
// installed binary with a real MCP client over stdio.
//
// `bun run check` only ever sees the source tree, so it can't catch what the `files` allowlist leaves
// out or what fails to resolve once the package is installed somewhere else. This can.
//
// No credentials needed: the server starts fine without a session (tools just return the re-auth
// message). The transport's default environment is an allowlist that excludes FORKABLE_* anyway, and
// FORKABLE_MCP_HOME is pinned to a temp dir so a local run can't touch a real session.

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const EXPECTED_TOOLS = [
  "confirm_delivery",
  "explain_pick",
  "get_delivery_status",
  "get_menus",
  "get_profile",
  "list_deliveries",
  "recommend_meals",
  "remove_meal",
  "search_items",
  "set_meal",
  "set_meal_all",
  "skip_delivery",
];

const log = (msg: string) => console.log(`  ${msg}`);

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) fail(`\`${cmd.join(" ")}\` exited ${code}\n${err || out}`);
}

const tmp = await mkdtemp(join(tmpdir(), "forkable-smoke-"));
try {
  log(`packing ${pkg.name}@${pkg.version}`);
  await run(["bun", "pm", "pack", "--destination", tmp], process.cwd());
  const tgz = [...new Bun.Glob("*.tgz").scanSync(tmp)][0];
  if (!tgz) fail("bun pm pack produced no tarball");

  const consumer = join(tmp, "consumer");
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true }),
  );

  log(`installing ${tgz} into a scratch project`);
  await run(["bun", "add", join(tmp, tgz)], consumer);

  const bin = join(consumer, "node_modules", ".bin", "forkable-mcp");
  if (!(await Bun.file(bin).exists())) fail(`no binary at ${bin} — check package.json "bin"`);

  log("connecting a real MCP client to the installed binary");
  const client = new Client({ name: "smoke", version: "0" });
  const transport = new StdioClientTransport({
    command: bin,
    cwd: consumer,
    env: { PATH: process.env.PATH ?? "", FORKABLE_MCP_HOME: join(tmp, "home") },
    stderr: "pipe",
  });
  // A startup crash surfaces as a bare "Connection closed", so keep the child's stderr to report
  // the actual cause. The stream only exists once connect() has started the transport.
  const connecting = client.connect(transport);
  let childErr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    childErr += d.toString();
  });
  const timer = setTimeout(() => fail("timed out connecting — the server never came up"), 30_000);
  await connecting.catch((e: Error) => fail(`connect failed: ${e.message}\n${childErr.trim()}`));
  clearTimeout(timer);

  const version = client.getServerVersion()?.version;
  if (version !== pkg.version)
    fail(`server reports v${version}, package.json says v${pkg.version}`);
  log(`serverInfo.version = ${version}`);

  const names = (await client.listTools()).tools.map((t) => t.name).toSorted();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
  if (missing.length) fail(`missing tools: ${missing.join(", ")}`);
  if (extra.length) fail(`unexpected tools (update EXPECTED_TOOLS?): ${extra.join(", ")}`);
  log(`${names.length} tools registered`);

  // Prove a tool actually dispatches. Unauthenticated, so the re-auth message is the pass condition —
  // what matters is that the handler ran instead of the process falling over.
  const res: any = await client.callTool({ name: "get_profile", arguments: {} });
  const text = (res.content ?? []).map((c: any) => c.text ?? "").join("");
  if (!text.trim()) fail("get_profile returned no content");
  log(`get_profile responded (${text.split("\n")[0].slice(0, 60)}…)`);

  await client.close();
  console.log("\n✓ packaged install works");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
