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
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };

const exec = promisify(execFile);

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
type Runner = "bunx" | "npx";

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const [command, ...args] = cmd;
  try {
    await exec(command!, args, { cwd });
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    fail(
      `\`${cmd.join(" ")}\` exited ${result.code ?? "unknown"}\n${result.stderr || result.stdout || result.message}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function findTarball(path: string): Promise<string> {
  const input = resolve(path);
  if ((await stat(input)).isFile()) return input;
  const file = (await readdir(input)).find((name) => name.endsWith(".tgz"));
  if (!file) fail(`no package tarball found in ${input}`);
  return join(input, file);
}

async function checkInstalled(runner: Runner, cwd: string, home: string): Promise<void> {
  log(`connecting with ${runner}`);
  const client = new Client({ name: `smoke-${runner}`, version: "0" });
  const transport = new StdioClientTransport({
    command: runner,
    args: runner === "bunx" ? ["--bun", "forkable-mcp"] : ["forkable-mcp"],
    cwd,
    env: { PATH: process.env.PATH ?? "", FORKABLE_MCP_HOME: home },
    stderr: "pipe",
  });
  const connecting = client.connect(transport);
  let childErr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    childErr += d.toString();
  });
  const timer = setTimeout(() => fail(`timed out connecting with ${runner}`), 30_000);
  await connecting.catch((e: Error) =>
    fail(`${runner} connect failed: ${e.message}\n${childErr.trim()}`),
  );
  clearTimeout(timer);

  const version = client.getServerVersion()?.version;
  if (version !== pkg.version)
    fail(`${runner} server reports v${version}, package.json says v${pkg.version}`);
  log(`${runner} serverInfo.version = ${version}`);

  const listedTools = (await client.listTools()).tools;
  const names = listedTools.map((tool) => tool.name).toSorted();
  const missing = EXPECTED_TOOLS.filter((tool) => !names.includes(tool));
  const extra = names.filter((tool) => !EXPECTED_TOOLS.includes(tool));
  if (missing.length) fail(`${runner} missing tools: ${missing.join(", ")}`);
  if (extra.length) fail(`${runner} unexpected tools: ${extra.join(", ")}`);
  log(`${runner} registered ${names.length} tools`);

  for (const name of ["set_meal", "set_meal_all"]) {
    const tool = listedTools.find((candidate) => candidate.name === name);
    const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    if (!required.includes("menuId")) fail(`${runner}: ${name} does not require menuId`);
  }
  const setMeal = listedTools.find((tool) => tool.name === "set_meal");
  const setMealProperties = (
    setMeal?.inputSchema as { properties?: Record<string, unknown> } | undefined
  )?.properties;
  if (!setMealProperties?.sourcePieceId) fail(`${runner}: set_meal does not expose sourcePieceId`);
  const mode = setMealProperties?.mode as { enum?: unknown[] } | undefined;
  if (JSON.stringify(mode?.enum) !== JSON.stringify(["set", "add"])) {
    fail(`${runner}: set_meal does not expose set/add mode`);
  }
  log(`${runner} write schemas require exact menu identity and expose additional meals`);

  const res: any = await client.callTool({ name: "get_profile", arguments: {} });
  const text = (res.content ?? []).map((content: any) => content.text ?? "").join("");
  if (!text.trim()) fail(`${runner}: get_profile returned no content`);
  log(`${runner} get_profile responded (${text.split("\n")[0].slice(0, 60)}…)`);

  await client.close();
}

async function checkPackage(runner: Runner, root: string, tarball: string): Promise<void> {
  const consumer = join(root, `consumer-${runner}`);
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }));

  log(`installing with ${runner === "bunx" ? "bun" : "npm"}`);
  if (runner === "bunx") await run(["bun", "add", tarball], consumer);
  else await run(["npm", "install", "--cache", join(root, "npm-cache"), tarball], consumer);

  const bin = join(consumer, "node_modules", ".bin", "forkable-mcp");
  if (!(await exists(bin))) fail(`no binary at ${bin} — check package.json "bin"`);
  await checkInstalled(runner, consumer, join(root, `home-${runner}`));
}

const tmp = await mkdtemp(join(tmpdir(), "forkable-smoke-"));
try {
  const requested = process.argv[2];
  if (requested && requested !== "bunx" && requested !== "npx") {
    fail(`unknown runner ${requested}; expected bunx or npx`);
  }
  const runners: Runner[] =
    requested === "bunx" || requested === "npx" ? [requested] : ["bunx", "npx"];
  let tarball: string;
  if (process.argv[3]) {
    tarball = await findTarball(process.argv[3]);
  } else {
    log(`packing ${pkg.name}@${pkg.version}`);
    await run(["bun", "pm", "pack", "--destination", tmp], process.cwd());
    tarball = await findTarball(tmp);
  }
  await Promise.all(runners.map((runner) => checkPackage(runner, tmp, tarball)));
  console.log(`\n✓ packaged install works with ${runners.join(" and ")}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
