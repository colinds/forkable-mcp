#!/usr/bin/env bun
// Install the packed artifact and check stdio startup and the bundled UI under Node and Bun.
// Temporary auth storage and an isolated environment keep this check credential-free.

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pkg from "../apps/mcp/package.json" with { type: "json" };

const exec = promisify(execFile);

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
  const browser = (await client.listTools()).tools.find((tool) => tool.name === "open_forkable");
  const ui = browser?.["_meta"]?.ui as { resourceUri?: string } | undefined;
  if (!ui?.resourceUri) fail(`${runner}: meal browser has no UI resource`);
  const resource = await client.readResource({ uri: ui.resourceUri });
  const html = resource.contents.find((content) => "text" in content);
  if (!html || !("text" in html) || !html.text.includes('<script type="module">'))
    fail(`${runner}: bundled browser HTML is missing`);
  log(`${runner} meal browser resource is packaged and readable`);

  const result = await client.callTool({ name: "get_profile", arguments: {} });
  if (
    !("content" in result) ||
    !result.content.some((part) => part.type === "text" && part.text.trim())
  )
    fail(`${runner}: read-only tool returned no response`);
  log(`${runner} read-only tool responded`);

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
    await run(
      ["bun", "pm", "pack", "--destination", tmp],
      fileURLToPath(new URL("../apps/mcp/", import.meta.url)),
    );
    tarball = await findTarball(tmp);
  }
  await Promise.all(runners.map((runner) => checkPackage(runner, tmp, tarball)));
  console.log(`\n✓ packaged install works with ${runners.join(" and ")}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
