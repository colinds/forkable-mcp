import {
  ResourceTemplate,
  type McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export interface MentionReference {
  deliveryId: number;
  menuId?: number;
  itemId?: number;
}
export function mentionDate(iso?: string, weekday: "short" | "long" = "short"): string {
  const date = new Date(`${iso?.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Upcoming";
  return new Intl.DateTimeFormat("en-US", {
    weekday,
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}
export function mentionUri(ref: MentionReference): string {
  const delivery = `forkable://delivery/${ref.deliveryId}`;
  return ref.menuId == null || ref.itemId == null
    ? delivery
    : `${delivery}/menu/${ref.menuId}/item/${ref.itemId}`;
}
export function registerMentions(
  server: McpServer,
  handlers: {
    search: (query: string) => Promise<CallToolResult>;
    read: (ref: MentionReference) => Promise<CallToolResult>;
  },
) {
  const capability = { "openai/mentions": { searchTool: "search_mentions" } };
  server.server.registerCapabilities({ extensions: capability, experimental: capability });

  server.registerTool(
    "search_mentions",
    {
      title: "Search Forkable references",
      description: "Find upcoming Forkable deliveries and available meals for composer mentions.",
      inputSchema: z.object({ query: z.string().max(200) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { "openai/extensions": { "mentions/search": {} }, ui: { visibility: ["app"] } },
    },
    ({ query }) => handlers.search(query),
  );
  const id = z.coerce.number().int().positive();
  for (const [name, template, meal] of [
    ["forkable-delivery", "forkable://delivery/{deliveryId}", false],
    ["forkable-meal", "forkable://delivery/{deliveryId}/menu/{menuId}/item/{itemId}", true],
  ] as const) {
    server.registerResource(
      name,
      new ResourceTemplate(template, { list: undefined }),
      { mimeType: "text/markdown" },
      async (uri, variables) => {
        const ref: MentionReference = { deliveryId: id.parse(variables.deliveryId) };
        if (meal) {
          ref.menuId = id.parse(variables.menuId);
          ref.itemId = id.parse(variables.itemId);
        }
        const result = await handlers.read(ref);
        const text = result.content
          .flatMap((content) => (content.type === "text" ? [content.text] : []))
          .join("\n");
        if (result.isError)
          throw new Error(text || "This Forkable reference is no longer available.");
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      },
    );
  }
}
