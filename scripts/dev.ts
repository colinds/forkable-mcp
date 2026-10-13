import { watch } from "node:fs";

let build: ReturnType<typeof Bun.spawn> | undefined;
let rebuilding = false;
let queued = false;
let stopping = false;
async function rebuild() {
  queued = true;
  if (rebuilding || stopping) return;
  rebuilding = true;
  try {
    while (queued) {
      if (stopping) break;
      queued = false;
      build = Bun.spawn(["bun", "scripts/build.ts"], { stdout: "ignore", stderr: "inherit" });
      // eslint-disable-next-line no-await-in-loop -- Rebuilds write the same output and must be serialized.
      const exitCode = await build.exited;
      if (exitCode && !stopping) console.error("Build failed; fix the error to rebuild the UI.");
    }
  } finally {
    rebuilding = false;
  }
}
await rebuild();
const server = Bun.spawn(["bun", "--watch", "src/index.ts"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
let timer: ReturnType<typeof setTimeout> | undefined;
const watcher = watch("src/app", { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 100);
});
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  watcher.close();
  if (build?.exitCode === null) build.kill();
  if (server.exitCode === null) server.kill();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await server.exited;
} finally {
  stop();
}
