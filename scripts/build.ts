import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("node_modules/@openai/mcp-extensions/LICENSE", "dist/mcp-extensions-LICENSE");

const development = process.env.NODE_ENV === "development";

const app = await Bun.build({
  entrypoints: ["src/app/index.html"],
  compile: true,
  target: "browser",
  minify: !development,
  define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") },
});

if (!app.success) throw new AggregateError(app.logs, "Meal browser build failed");

await Bun.write("dist/app.html", app.outputs[0]!);

const server = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "node",
  define: { APP_HTML_PATH: JSON.stringify("./app.html") },
  format: "esm",
  packages: "external",
  outdir: "dist",
});

if (!server.success) throw new AggregateError(server.logs, "Server build failed");
