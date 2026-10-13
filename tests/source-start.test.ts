import { test, expect } from "bun:test";
import { cp, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_URI } from "@/server/ui-server.ts";

test("source startup builds a missing UI bundle before serving stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forkable-source-start-"));
  const client = new Client({ name: "source-start-test", version: "0" });
  try {
    await cp("src", join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "scripts"));
    await cp("scripts/build.ts", join(dir, "scripts/build.ts"));
    await Promise.all(["package.json", "tsconfig.json"].map((file) => cp(file, join(dir, file))));
    await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "start"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", FORKABLE_MCP_HOME: join(dir, "session") },
      stderr: "pipe",
    });
    const connecting = client.connect(transport);
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    await connecting.catch((error) => {
      throw new Error(`Source startup failed: ${diagnostics}`, { cause: error });
    });
    const resource = await client.readResource({ uri: APP_URI });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(await Bun.file(join(dir, "dist/app.html")).exists()).toBe(true);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
