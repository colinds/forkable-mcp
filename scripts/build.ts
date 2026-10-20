import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await Promise.all([
  copyFile("node_modules/@openai/mcp-extensions/LICENSE", "dist/mcp-extensions-LICENSE"),
  copyFile("node_modules/lucide-react/LICENSE", "dist/lucide-LICENSE"),
]);

const development = process.env.NODE_ENV === "development";
const sourcemap = development ? "inline" : "none";

const [app, server] = await Promise.all([
  Bun.build({
    entrypoints: ["src/app/index.html"],
    compile: true,
    target: "browser",
    minify: !development,
    sourcemap,
    define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
    naming: "app.[ext]",
    outdir: "dist",
  }),
  Bun.build({
    entrypoints: ["src/index.ts"],
    target: "node",
    sourcemap,
    define: { APP_HTML_PATH: JSON.stringify("./app.html") },
    format: "esm",
    packages: "external",
    outdir: "dist",
  }),
]);

if (!app.success || !server.success)
  throw new AggregateError([...app.logs, ...server.logs], "Forkable build failed");
