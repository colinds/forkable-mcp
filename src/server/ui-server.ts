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
      "Show the interactive Forkable app when the user asks to see a meal or browse lunch. Resolve the requested delivery and any menu details with data tools first, then call this tool once as the final display step. The app loads its own data; additional reads are not needed to render it. Pass view=delivery with deliveryId for a focused delivery answer, view=meals for meal results, or view=browse for the full browser. Views are chosen automatically when omitted. Pass query and/or filters to show matching meals inline, combining restaurantId, diet, maxPrice, recommendedOnly, and sort. Search and filters apply to the selected delivery only; from/to bound the available delivery dates, not a search across dates. Always pass the matching deliveryId when showing meals found by another tool. Filters match the app controls. limit controls how many recommendations are requested. To show a specific dish, pass deliveryId, menuId and itemId together. Clients without MCP Apps should use list_deliveries and get_menus for meal data; this tool only returns launch instructions.",
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
