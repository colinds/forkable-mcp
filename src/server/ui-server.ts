import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  type McpUiAppToolConfig,
} from "@modelcontextprotocol/ext-apps/server";
import { openBrowserInputSchema } from "@/shared/contracts/browser.ts";
import { FORK_ICONS } from "./ui-icon.ts";
import { IMAGE_ORIGINS } from "../shared/images.ts";

declare const APP_HTML_PATH: string;

export const APP_URI = "ui://forkable/meal-browser.html";

export const MEAL_BROWSER_INSTRUCTIONS =
  "When showing Forkable meals, resolve the requested delivery and menu details with data tools first, " +
  "then call open_forkable once as the final display step. The app loads its own data; " +
  "additional reads are not needed to render it. Always pass the matching deliveryId when showing " +
  "meals found by another tool. Search and filters apply to that delivery only; from/to bound " +
  "available delivery dates, not a search across dates. Use view=delivery for a focused delivery, " +
  "view=meals for meal results, or view=browse for full browsing. Views are chosen automatically " +
  "when omitted. For an exact dish, pass deliveryId, menuId and itemId together. " +
  "Clients without MCP Apps should use list_deliveries and get_menus; open_forkable returns " +
  "launch instructions rather than meal data.";

// Standard MCP Apps metadata with aliases for OpenAI hosts using the earlier UI bridge.
export const MEAL_APP_META = {
  ui: { resourceUri: APP_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": APP_URI,
  "openai/widgetAccessible": true,
} satisfies McpUiAppToolConfig["_meta"];

export function registerMealBrowser(
  server: McpServer,
  readHtml = () =>
    readFile(
      new URL(
        typeof APP_HTML_PATH === "undefined" ? "../../dist/app.html" : APP_HTML_PATH,
        import.meta.url,
      ),
      "utf8",
    ),
): void {
  const openTool = {
    title: "Forkable",
    icons: FORK_ICONS,
    description:
      "Show an interactive delivery, meal search, or lunch browser in Forkable. " +
      "Use for requests to see meals; use data tools for text-only answers. " +
      "Resolve the matching delivery/menu IDs first, then open once as the final display step. " +
      "Search and filters apply to one delivery. Opening the app does not place an order; " +
      "this tool returns launch instructions, not meal data.",
    inputSchema: openBrowserInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ...MEAL_APP_META,
      "openai/iconStyle": "monochrome",
      "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
    },
  } satisfies McpUiAppToolConfig & { icons: typeof FORK_ICONS };

  registerAppTool(server, "open_forkable", openTool, async () => ({
    content: [
      {
        type: "text",
        text: "Forkable view ready. The app loads the requested delivery and filters; this launch result contains no meal data.",
      },
    ],
    structuredContent: {},
  }));

  registerAppResource(server, "Forkable meal browser", APP_URI, {}, async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              connectDomains: [],
              resourceDomains: [...IMAGE_ORIGINS, "https://assets.claude.ai"],
            },
          },
          "openai/ui": {
            preferredDisplayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      },
    ],
  }));
}
