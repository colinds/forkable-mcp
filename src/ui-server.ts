import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  type McpUiAppToolConfig,
} from "@modelcontextprotocol/ext-apps/server";
import { openBrowserInputSchema } from "./app/lib/initial-view.ts";
import { FORK_ICONS } from "./ui-icon.ts";
import { IMAGE_ORIGINS } from "./app/lib/model.ts";
export const APP_URI = "ui://forkable/meal-browser-v2.html";
// Standard MCP Apps metadata with aliases for OpenAI hosts using the earlier UI bridge.
export const MEAL_APP_META = {
  ui: { resourceUri: APP_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": APP_URI,
  "openai/widgetAccessible": true,
} satisfies McpUiAppToolConfig["_meta"];
export function registerMealBrowser(
  server: McpServer,
  readHtml = () => readFile(new URL("../dist/app.html", import.meta.url), "utf8"),
): void {
  const openTool = {
    title: "Forkable",
    icons: FORK_ICONS,
    description:
      "Show the interactive Forkable app when the user asks to see a meal or browse lunch. Optionally pass deliveryId to focus a delivery. To show a specific dish, pass deliveryId, menuId and itemId together. Works as text in clients without MCP Apps.",
    inputSchema: openBrowserInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ...MEAL_APP_META,
      "openai/iconStyle": "monochrome",
      "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
    },
  } satisfies McpUiAppToolConfig & { icons: typeof FORK_ICONS };
  registerAppTool(
    server,
    "open_forkable",
    openTool,

    async () => ({
      content: [
        {
          type: "text",
          text: "Open the Forkable meal browser. You can also use list_deliveries and get_menus to browse in chat.",
        },
      ],
      structuredContent: {},
    }),
  );
  registerAppResource(server, "Forkable meal browser", APP_URI, {}, async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readHtml(),
        _meta: {
          ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: IMAGE_ORIGINS } },
          "openai/ui": {
            preferredDisplayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      },
    ],
  }));
}
