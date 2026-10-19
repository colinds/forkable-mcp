import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.pw.ts",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:54317", headless: true },
  webServer: {
    command: "NODE_ENV=development bun run build && bun tests/browser/host-server.ts",
    cwd: "../..",
    url: "http://127.0.0.1:54317",
    reuseExistingServer: false,
  },
  reporter: "list",
  outputDir: "../../test-results",
});
