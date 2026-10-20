import { test, expect } from "bun:test";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_URI } from "@/server/ui-server.ts";

async function waitForHtml(dir: string, text: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- Observe the real compiler's asynchronous rebuild.
    if ((await Bun.file(join(dir, "dist/app.html")).text()).includes(text)) return;
    // eslint-disable-next-line no-await-in-loop -- Bound polling while the native watcher rebuilds.
    await Bun.sleep(50);
  }
  throw new Error(`The app did not rebuild with ${text}.`);
}

test.each(["start", "dev"])(
  "%s builds a missing UI bundle before serving stdio",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "forkable-source-start-"));
    const client = new Client({ name: "source-start-test", version: "0" });
    try {
      await Promise.all([
        cp("src", join(dir, "src"), { recursive: true }),
        cp("scripts", join(dir, "scripts"), { recursive: true }),
        ...["package.json", "tsconfig.json"].map((file) => cp(file, join(dir, file))),
        symlink(resolve("node_modules"), join(dir, "node_modules"), "dir"),
      ]);
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", mode],
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
      const html = Bun.file(join(dir, "dist/app.html"));
      const sourceMap = "sourceMappingURL=data:application/json;base64,";
      const markup = await html.text();
      expect(markup.includes(sourceMap)).toBe(mode === "dev");
      expect(markup.includes("react-dom-client.development")).toBe(mode === "dev");
      expect((await Bun.file(join(dir, "dist/index.js")).text()).includes(sourceMap)).toBe(
        mode === "dev",
      );
      if (mode === "dev") {
        const css = Bun.file(join(dir, "src/app/styles.css"));
        const originalCss = await css.text();
        await Bun.write(css, `${originalCss}\nbody { --rebuild-probe: css-rebuilt; }`);
        await waitForHtml(dir, "css-rebuilt");
        const entry = Bun.file(join(dir, "src/app/index.tsx"));
        const originalEntry = await entry.text();
        await Bun.write(entry, "export const broken = ;");
        await Bun.sleep(300);
        await Bun.write(entry, `${originalEntry}\nconsole.debug("syntax-recovered");`);
        await waitForHtml(dir, "syntax-recovered");
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
        expect((await client.readResource({ uri: APP_URI })).contents[0]).toMatchObject({
          text: expect.stringContaining("css-rebuilt"),
        });
        await client.close();
        const stoppedHtml = await html.text();
        await Bun.write(css, `${originalCss}\nbody { --rebuild-probe: after-shutdown; }`);
        await Bun.sleep(300);
        expect(await html.text()).toBe(stoppedHtml);
      }
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);
