import { mkdir, writeFile, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await copyFile("node_modules/@openai/mcp-extensions/LICENSE", "dist/mcp-extensions-LICENSE");
const app = await Bun.build({
  entrypoints: ["src/app/index.tsx"],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!app.success) throw new AggregateError(app.logs, "Meal browser build failed");
const js = await app.outputs.find((o) => o.path.endsWith(".js"))!.text();
const css = await app.outputs.find((o) => o.path.endsWith(".css"))!.text();
await writeFile(
  "dist/app.html",
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forkable</title><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><main id="app"><p role="status">Connecting to Forkable…</p></main><script type="module">${js.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
const server = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "node",
  format: "esm",
  packages: "external",
  outdir: "dist",
});
if (!server.success) throw new AggregateError(server.logs, "Server build failed");
