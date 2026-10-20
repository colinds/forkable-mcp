import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pkg from "../apps/mcp/package.json" with { type: "json" };

const root = new URL("../", import.meta.url);
const dist = new URL("apps/mcp/dist/", root);
const skills = new URL("../skills/", dist);
await mkdir(dist, { recursive: true });
await rm(skills, { recursive: true, force: true });
await Promise.all([
  copyFile(
    new URL("apps/mcp/node_modules/@openai/mcp-extensions/LICENSE", root),
    new URL("mcp-extensions-LICENSE", dist),
  ),
  copyFile(
    new URL("apps/mcp/node_modules/lucide-static/LICENSE", root),
    new URL("lucide-LICENSE", dist),
  ),
  copyFile(new URL("README.md", root), new URL("../README.md", dist)),
  copyFile(new URL("LICENSE", root), new URL("../LICENSE", dist)),
  cp(new URL("skills/", root), skills, { recursive: true }),
]);

const development = process.env.NODE_ENV === "development";
const sourcemap = development ? "inline" : "none";

const [app, server] = await Promise.all([
  Bun.build({
    entrypoints: [fileURLToPath(new URL("apps/app/src/index.html", root))],
    compile: true,
    target: "browser",
    minify: !development,
    sourcemap,
    define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
    naming: "app.[ext]",
    outdir: fileURLToPath(dist),
  }),
  Bun.build({
    entrypoints: [fileURLToPath(new URL("apps/mcp/src/index.ts", root))],
    target: "node",
    sourcemap,
    define: { APP_HTML_PATH: JSON.stringify("./app.html") },
    format: "esm",
    external: Object.keys(pkg.dependencies),
    outdir: fileURLToPath(dist),
  }),
]);

if (!app.success || !server.success)
  throw new AggregateError([...app.logs, ...server.logs], "Forkable build failed");
