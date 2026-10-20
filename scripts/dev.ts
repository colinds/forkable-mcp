import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

process.env.NODE_ENV = "development";
await import("./build.ts");

const app = Bun.spawn(
  [
    process.execPath,
    "build",
    "apps/app/src/index.html",
    "--compile",
    "--target=browser",
    "--outfile=apps/mcp/dist/app.html",
    "--sourcemap=inline",
    "--define",
    'process.env.NODE_ENV:"development"',
    "--watch",
    "--no-clear-screen",
  ],
  { cwd: root, stdout: "ignore", stderr: "inherit" },
);

const server = Bun.spawn(
  [process.execPath, "--watch", "--no-clear-screen", "apps/mcp/src/index.ts"],
  {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

function stop() {
  if (app.exitCode === null) app.kill();
  if (server.exitCode === null) server.kill();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  process.exitCode = await Promise.race([server.exited, app.exited.then((code) => code || 1)]);
} finally {
  stop();
  await Promise.all([app.exited, server.exited]);
}
