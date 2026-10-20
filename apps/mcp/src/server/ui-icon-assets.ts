import { readFileSync } from "node:fs";

/** Embed the PNG at build time so stdio clients need no image server or local file access. */
export function forkPngIcon() {
  const png = readFileSync(new URL("./assets/fork.png", import.meta.url));
  return {
    src: `data:image/png;base64,${png.toString("base64")}`,
    mimeType: "image/png",
    sizes: ["128x128"],
  };
}
