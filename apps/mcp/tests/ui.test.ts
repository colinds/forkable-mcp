import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerMealBrowser, APP_URI, MEAL_BROWSER_INSTRUCTIONS } from "@/server/ui-server.ts";

test("publishes sidebar and thread entrypoints and constrained UI resource over MCP", async () => {
  const server = new McpServer(
    { name: "test", version: "0" },
    { instructions: MEAL_BROWSER_INSTRUCTIONS },
  );
  registerMealBrowser(server, async () => "<!doctype html><html>Forkable</html>");
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "open_forkable")!;
    expect(tool.description).toContain("interactive delivery, meal search");
    expect(tool.description).toContain("data tools for text-only answers");
    expect(tool.description).toContain("final display step");
    expect(tool.description).toContain("one delivery");
    expect(tool.description).toContain("not meal data");
    expect(tool.inputSchema.properties?.deliveryId).toMatchObject({
      description: expect.stringContaining("Always pass the matching delivery"),
    });
    expect(tool.inputSchema.properties?.menuId).toMatchObject({
      description: expect.stringContaining("deliveryId, menuId and itemId together"),
    });
    expect(tool.inputSchema.properties?.view).toMatchObject({
      description: expect.stringContaining("meals: show search/filter results immediately"),
    });
    expect(tool.inputSchema.properties?.from).toMatchObject({
      description: expect.stringContaining("not a meal search across dates"),
    });
    expect(client.getInstructions()).toContain("final display step");
    expect(tool["_meta"]?.["openai/ui"]).toEqual({
      entrypoints: [{ type: "global" }, { type: "thread" }],
    });
    const vectors = tool.icons?.filter((icon) => icon.mimeType === "image/svg+xml");
    expect(vectors?.map((icon) => icon.theme)).toEqual(["light", "dark"]);
    expect(vectors?.every((icon) => icon.src.startsWith("data:image/svg+xml,"))).toBe(true);
    const png = tool.icons?.find((icon) => icon.mimeType === "image/png");
    expect(png?.sizes).toEqual(["128x128"]);
    expect(png?.src).toStartWith("data:image/png;base64,iVBORw0KGgo");
    expect(tool["_meta"]?.ui).toMatchObject({ resourceUri: APP_URI });
    expect((await client.callTool({ name: "open_forkable", arguments: {} })).isError).not.toBe(
      true,
    );
    expect(
      (
        await client.callTool({
          name: "open_forkable",
          arguments: {
            deliveryId: 1,
            filters: {
              restaurantId: 10,
              diet: "Vegetarian",
              maxPrice: 18,
              recommendedOnly: true,
              sort: "price-low",
            },
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (await client.callTool({ name: "open_forkable", arguments: { filters: { maxPrice: -1 } } }))
        .isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: "open_forkable", arguments: { menuId: 10, itemId: 7 } }))
        .isError,
    ).toBe(true);
    const invalidResults = await Promise.all(
      [{ from: "today" }, { from: "2026-02-30" }, { from: "2026-10-20", to: "2026-10-10" }].map(
        (args) => client.callTool({ name: "open_forkable", arguments: args }),
      ),
    );
    for (const result of invalidResults) expect(result.isError).toBe(true);
    const resource = (await client.readResource({ uri: APP_URI })).contents[0]!;
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource["_meta"]?.ui).toMatchObject({
      prefersBorder: false,
      csp: {
        connectDomains: [],
        resourceDomains: ["https://cdn.filestackcontent.com", "https://assets.claude.ai"],
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

for (const target of [
  undefined,
  "codex://plugins/forkable-mcp@local/app/open_forkable",
  "javascript:alert(1)",
]) {
  test(`launch result exposes only a valid configured app target (${target ? new URL(target).protocol : "unset"})`, async () => {
    const server = new McpServer({ name: "links", version: "0" });
    registerMealBrowser(server, async () => "<!doctype html><html>Forkable</html>", target ?? "");
    const client = new Client({ name: "links", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await client.listTools();
      const result = await client.callTool({ name: "open_forkable", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(
        target?.startsWith("codex:") ? { appUrl: target } : {},
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
}
