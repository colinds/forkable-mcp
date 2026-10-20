import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallToolResult, McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { APP_URI, registerMealBrowser } from "@/server/ui-server.ts";
import { Client } from "@modelcontextprotocol/client";
import { patchSession } from "@/server/auth/session.ts";
import { ForkableClient } from "@/server/net/client.ts";
import { ReauthRequiredError } from "@/server/net/errors.ts";
import { type Delivery, type Menu } from "@/server/order/types.ts";
import { registerAllTools } from "@/server/tools/index.ts";
import { createWriteGate } from "@/server/write-gate.ts";

import {
  deliveriesSchema,
  deliveryStatusSchema,
  menusSchema,
  searchResultsSchema,
  itemDetailSchema,
  recommendationsSchema,
} from "@forkable/shared/contracts/meals.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const USER_ID = 42;
const DELIVERY_ID = 1;
const MENU_ID = 10;
const ITEM_ID = 20;

const delivery: Delivery = {
  id: DELIVERY_ID,
  forDeliveryAt: "2026-08-28T12:00:00-07:00",
  state: "scheduled",
  userConfirmed: true,
  availableMenuIds: [MENU_ID],
  allowanceType: "weekly",
  copayAmount: 20,
  weeklyAllowance: 100,
  weeklyAllowanceAvailable: 35.5,
  serviceWindow: { name: "lunch" },
  deliveryWindow: ["11:30 AM", "12:30 PM"],
  club: { id: 7, name: "HQ", market: { timezone: "America/Los_Angeles" } },
  address: { formatted: "123 Main St", notes: "Use the side door" },
  userReceipt: { due: 4.5, clubCopay: 15 },
  orders: [
    {
      id: 101,
      venue: { displayName: "Test Kitchen" },
      etaStatus: {
        status: "delayed",
        start: "2026-08-28T11:45:00-07:00",
        end: "2026-08-28T12:00:00-07:00",
        shortTz: "PT",
        trackingUrl: "https://track.example/101",
      },
      pieces: [
        {
          id: "piece-1",
          userId: USER_ID,
          menuId: MENU_ID,
          itemId: ITEM_ID,
          name: "Test Bowl",
          price: 12.5,
          group: "A1",
          isConfirmed: true,
          isRemoval: true,
          requestStatus: "pending",
          nonHiddenAttributes: [{ label: "Protein", value: "Tofu" }],
        },
      ],
    },
    {
      id: 102,
      venue: { displayName: "Second Kitchen" },
      etaStatus: {
        status: "ontime",
        start: "2026-08-28T12:05:00-07:00",
        end: "2026-08-28T12:20:00-07:00",
        shortTz: "PT",
        trackingUrl: "https://track.example/102",
      },
      pieces: [
        {
          id: "piece-2",
          userId: USER_ID,
          menuId: MENU_ID + 1,
          itemId: ITEM_ID + 1,
          name: "Second Bowl",
          price: 14,
          group: "B2",
          isConfirmed: true,
        },
      ],
    },
  ],
};

const menu: Menu = {
  id: MENU_ID,
  name: "Test Kitchen",
  sections: [
    {
      items: [
        {
          id: ITEM_ID,
          menuId: MENU_ID,
          name: "Test Bowl",
          description: "A useful description",
          price: 12.5,
          imageUrl: "https://images.example/bowl.jpg",
          dietLevel: 1,
          modifiers: [
            {
              id: 30,
              name: "Protein",
              required: true,
              min: 1,
              max: 1,
              options: [{ id: 31, name: "Tofu", price: 1 }],
            },
          ],
        },
      ],
    },
  ],
};

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe("read tool responses", () => {
  let home: string;
  let handlers: Map<string, ToolHandler>;
  let originalGql: typeof ForkableClient.prototype.gql;
  let originalQuery: typeof ForkableClient.prototype.query;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "forkable-tools-read-"));
    process.env.FORKABLE_MCP_HOME = home;
    await patchSession({
      cookie: "_easyorder_session=test",
      csrf: "test-csrf",
    });

    originalGql = ForkableClient.prototype.gql;
    originalQuery = ForkableClient.prototype.query;
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: [structuredClone(delivery)],
      me: { id: USER_ID },
    })) as typeof ForkableClient.prototype.gql;
    ForkableClient.prototype.query = (async (root: string) => {
      if (root === "me") {
        return {
          id: USER_ID,
          fullName: "Test User",
          email: "test@example.com",
          mfaEnabled: true,
          validCreditCard: true,
          mealClubAutoOrder: true,
        };
      }
      if (root === "mealClubsAs") return [{ id: 7, name: "HQ", allowanceType: "daily" }];
      if (root === "myInProgressDeliveryIds") return [];
      if (root === "menus") return [structuredClone(menu)];
      if (root === "diets") return [{ level: 1, label: "vegetarian" }];
      if (root === "searchMenuItems") return { nodes: [{ id: ITEM_ID, menuId: MENU_ID }] };
      if (root === "mealGenerationScores") {
        return [{ menuId: MENU_ID, itemId: ITEM_ID, score: 0.91 }];
      }
      throw new Error(`unexpected query: ${root}`);
    }) as typeof ForkableClient.prototype.query;

    handlers = new Map();
    const server = {
      server: { registerCapabilities() {} },
      registerResource() {},
      registerTool(name: string, _definition: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerAllTools(server, createWriteGate());
  });

  afterEach(() => {
    ForkableClient.prototype.gql = originalGql;
    ForkableClient.prototype.query = originalQuery;
    delete process.env.FORKABLE_MCP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("mention search reuses menu requests only within the current call and club", async () => {
    const deliveries = [
      { ...structuredClone(delivery), id: 1 },
      { ...structuredClone(delivery), id: 2 },
      { ...structuredClone(delivery), id: 3, club: { ...delivery.club!, id: 8 } },
      { ...structuredClone(delivery), id: 4, availableMenuIds: [MENU_ID, 99] },
    ];
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: deliveries,
      me: { id: USER_ID },
    })) as typeof ForkableClient.prototype.gql;
    const query = ForkableClient.prototype.query;
    const menuRequests: unknown[] = [];
    ForkableClient.prototype.query = async function (this: ForkableClient, root, args, selection) {
      if (root === "menus") menuRequests.push(args);
      return query.call(this, root, args, selection);
    } as typeof ForkableClient.prototype.query;

    const search = handlers.get("search_mentions")!;
    const first = await search({ query: "bowl" });
    expect(first.isError).not.toBe(true);
    expect(menuRequests).toEqual([
      { ids: [MENU_ID], clubId: 7 },
      { ids: [MENU_ID], clubId: 8 },
      { ids: [MENU_ID, 99], clubId: 7 },
    ]);
    expect(first.structuredContent).toMatchObject({
      items: [1, 2, 3, 4].map((id) => ({
        uri: `forkable://delivery/${id}/menu/${MENU_ID}/item/${ITEM_ID}`,
      })),
    });
    expect((await search({ query: "bowl" })).structuredContent).toEqual(first.structuredContent);
    expect(menuRequests).toHaveLength(6);
  });

  for (const [version, ClientClass] of [
    ["v1", LegacyClient],
    ["v2", Client],
  ] as const) {
    test.each(["missing", "expired"] as const)(
      `reauth %s retains its structured code through MCP ${version}`,
      async (reason) => {
        if (reason === "missing") rmSync(join(home, "session.json"));
        else {
          const expired = async () => {
            throw new ReauthRequiredError("expired");
          };
          ForkableClient.prototype.gql = expired;
          ForkableClient.prototype.query = expired;
        }
        const email = process.env.FORKABLE_EMAIL;
        delete process.env.FORKABLE_EMAIL;
        const server = new McpServer({ name: "reauth-test", version: "0" });
        registerAllTools(server, createWriteGate());
        const client = new ClientClass({ name: "reauth-client", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        try {
          await Promise.all([server.connect(st), client.connect(ct)]);
          await client.listTools();
          const calls = [
            { name: "list_deliveries", arguments: {} },
            { name: "get_menus", arguments: { deliveryId: DELIVERY_ID } },
            { name: "search_items", arguments: { deliveryId: DELIVERY_ID, query: "bowl" } },
            { name: "recommend_meals", arguments: { deliveryId: DELIVERY_ID } },
            { name: "get_delivery_status", arguments: { deliveryId: DELIVERY_ID } },
            {
              name: "set_meal",
              arguments: { deliveryId: DELIVERY_ID, menuId: MENU_ID, itemId: ITEM_ID },
            },
            {
              name: "set_meal_all",
              arguments: { deliveryIds: [DELIVERY_ID], menuId: MENU_ID, itemId: ITEM_ID },
            },
            { name: "remove_meal", arguments: { deliveryId: DELIVERY_ID, pieceId: "piece-1" } },
            {
              name: "rate_meal",
              arguments: { deliveryId: DELIVERY_ID, pieceId: "piece-1", level: 5 },
            },
            { name: "confirm_delivery", arguments: { deliveryId: DELIVERY_ID } },
            {
              name: "prepare_meal",
              arguments: { deliveryId: DELIVERY_ID, menuId: MENU_ID, itemId: ITEM_ID },
            },
          ];
          const results = await Promise.all(calls.map((call) => client.callTool(call)));
          for (const result of results) {
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toEqual({
              error: "forkable_reauth_required",
              reason,
            });
            expect(result.content).toMatchObject([
              { type: "text", text: expect.stringContaining("provide a fresh browser cookie") },
            ]);
          }
          const profile = await client.callTool({ name: "get_profile", arguments: {} });
          expect(profile.isError).toBe(true);
          expect(profile.structuredContent).toEqual({
            error: "forkable_reauth_required",
            reason,
          });
        } finally {
          if (email === undefined) delete process.env.FORKABLE_EMAIL;
          else process.env.FORKABLE_EMAIL = email;
          await client.close();
          await server.close();
        }
      },
    );
  }

  test("read output validation tolerates missing optional wire fields", async () => {
    const incomplete = structuredClone(delivery);
    delete incomplete.forDeliveryAt;
    Object.assign(incomplete.orders![0]!.pieces![0]!, { name: null });
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: [incomplete],
      me: { id: USER_ID },
    })) as typeof ForkableClient.prototype.gql;
    const server = new McpServer({ name: "optional-wire-fields", version: "0" });
    registerAllTools(server, createWriteGate());
    const client = new Client({ name: "optional-fields-client", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await client.listTools();
      const [listed, status] = await Promise.all([
        client.callTool({ name: "list_deliveries", arguments: {} }),
        client.callTool({ name: "get_delivery_status", arguments: { deliveryId: DELIVERY_ID } }),
      ]);
      expect(listed.isError).not.toBe(true);
      expect(status.isError).not.toBe(true);
      const listedData = deliveriesSchema.parse(listed.structuredContent).deliveries[0]!;
      const statusData = deliveryStatusSchema.parse(status.structuredContent).status;
      expect(listedData.date).toBe("");
      expect(listedData.meals[0]?.name).toBeNull();
      expect(statusData.date).toBe("");
      expect(statusData.meals[0]?.name).toBe(`item ${ITEM_ID}`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  for (const [version, ClientClass] of [
    ["v1", LegacyClient],
    ["v2", Client],
  ] as const) {
    test(`public result contracts survive MCP serialization without losing fields (${version})`, async () => {
      const server = new McpServer({ name: "contract-test", version: "0" });
      registerAllTools(server, createWriteGate());
      const client = new ClientClass({ name: "contract-client", version: "0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(st), client.connect(ct)]);
        const definitions = (await client.listTools()).tools;
        const reads = [
          { name: "list_deliveries", args: {}, schema: deliveriesSchema },
          { name: "get_menus", args: { deliveryId: DELIVERY_ID }, schema: menusSchema },
          {
            name: "get_menus",
            args: { deliveryId: DELIVERY_ID, menuId: MENU_ID, itemId: ITEM_ID },
            schema: itemDetailSchema,
          },
          {
            name: "search_items",
            args: { deliveryId: DELIVERY_ID, query: "bowl" },
            schema: searchResultsSchema,
          },
          {
            name: "recommend_meals",
            args: { deliveryId: DELIVERY_ID },
            schema: recommendationsSchema,
          },
          {
            name: "get_delivery_status",
            args: { deliveryId: DELIVERY_ID },
            schema: deliveryStatusSchema,
          },
        ];
        await Promise.all(
          reads.map(async ({ name, args, schema }) => {
            expect(definitions.find((tool) => tool.name === name)?.outputSchema?.type).toBe(
              "object",
            );
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toEqual(schema.parse(result.structuredContent));
          }),
        );
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  test("composer mentions advertise discovery and resolve fresh account-scoped resources", async () => {
    const server = new McpServer({ name: "mentions-test", version: "0" });
    registerAllTools(server, createWriteGate());
    registerMealBrowser(server, async () => "<!doctype html><html>Forkable</html>");
    const client = new Client({ name: "test", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const definitions = (await client.listTools()).tools;
      for (const name of [
        "list_deliveries",
        "get_menus",
        "search_items",
        "recommend_meals",
        "get_delivery_status",
      ]) {
        expect(definitions.find((tool) => tool.name === name)?.["_meta"]).toMatchObject({
          ui: { visibility: ["model", "app"] },
          "openai/widgetAccessible": true,
        });
      }
      expect(
        definitions
          .filter(
            (tool) =>
              (tool["_meta"]?.ui as { resourceUri?: string } | undefined)?.resourceUri ||
              tool["_meta"]?.["ui/resourceUri"] ||
              tool["_meta"]?.["openai/outputTemplate"],
          )
          .map((tool) => tool.name),
      ).toEqual(["open_forkable"]);
      expect(definitions.find((tool) => tool.name === "open_forkable")?.["_meta"]).toMatchObject({
        ui: { resourceUri: APP_URI },
      });
      expect(definitions.find((tool) => tool.name === "set_meal")?.["_meta"]).toMatchObject({
        ui: { visibility: ["model", "app"] },
        "openai/widgetAccessible": true,
      });
      for (const name of ["set_meal_all", "remove_meal", "rate_meal", "confirm_delivery"])
        expect(definitions.find((tool) => tool.name === name)?.["_meta"]).toMatchObject({
          ui: { visibility: ["model"] },
        });
      expect(client.getServerCapabilities()?.extensions?.["openai/mentions"]).toEqual({
        searchTool: "search_mentions",
      });
      expect(client.getServerCapabilities()?.experimental?.["openai/mentions"]).toEqual({
        searchTool: "search_mentions",
      });
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "search_mentions",
      );
      expect(definition?.["_meta"]?.["openai/extensions"]).toEqual({ "mentions/search": {} });
      const deliveries = await client.callTool({
        name: "search_mentions",
        arguments: { query: "" },
      });
      expect(deliveries.structuredContent).toMatchObject({
        items: [{ name: "Fri, Aug 28 · Lunch", title: "Fri, Aug 28 · Lunch" }],
      });

      const weekday = await client.callTool({
        name: "search_mentions",
        arguments: { query: "Friday" },
      });
      expect(
        (weekday.structuredContent as { items: { uri: string }[] }).items.some(
          (item) => item.uri === `forkable://delivery/${DELIVERY_ID}`,
        ),
      ).toBe(true);
      const naturalDate = await client.callTool({
        name: "search_mentions",
        arguments: { query: "Aug 28" },
      });
      expect(
        (naturalDate.structuredContent as { items: { uri: string }[] }).items.some(
          (item) => item.uri === `forkable://delivery/${DELIVERY_ID}`,
        ),
      ).toBe(true);
      const result = await client.callTool({
        name: "search_mentions",
        arguments: { query: "useful" },
      });
      const items = (result.structuredContent as { items: { uri: string; title: string }[] }).items;
      expect(items).toHaveLength(1);
      expect(items[0]!.uri).toBe(
        `forkable://delivery/${DELIVERY_ID}/menu/${MENU_ID}/item/${ITEM_ID}`,
      );
      const resource = await client.readResource({ uri: items[0]!.uri });
      expect(resource.contents[0]).toMatchObject({ mimeType: "text/markdown" });
      expect(JSON.stringify(resource.contents)).toContain(items[0]!.uri);
      expect(
        resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "",
      ).toContain("A useful description");
      ForkableClient.prototype.gql = (async () => ({
        myDeliveries: [],
        me: { id: USER_ID + 1 },
      })) as typeof ForkableClient.prototype.gql;
      await expect(client.readResource({ uri: items[0]!.uri })).rejects.toThrow("no longer");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("status lookups send an explicit end date and reject backwards bounds", async () => {
    const documents: string[] = [];
    ForkableClient.prototype.gql = (async (document: string) => {
      documents.push(document);
      return { myDeliveries: [structuredClone(delivery)], me: { id: USER_ID } };
    }) as typeof ForkableClient.prototype.gql;
    const result = await handlers.get("get_delivery_status")!({
      deliveryId: DELIVERY_ID,
      from: "2026-08-28",
      to: "2026-08-28",
    });
    expect(result.isError).not.toBe(true);
    expect(documents[0]).toMatch(/from:\s*"2026-08-28"/);
    expect(documents[0]).toMatch(/to:\s*"2026-08-28"/);
    expect(
      (
        await handlers.get("get_delivery_status")!({
          deliveryId: DELIVERY_ID,
          from: "2026-08-29",
          to: "2026-08-28",
        })
      ).isError,
    ).toBe(true);
    expect(documents).toHaveLength(1);
  });

  test("actual read-tool results satisfy the browser contracts", async () => {
    expect(
      deliveryStatusSchema.safeParse(
        structured(await handlers.get("get_delivery_status")!({ deliveryId: DELIVERY_ID })),
      ).success,
    ).toBe(true);
    expect(
      deliveriesSchema.safeParse(structured(await handlers.get("list_deliveries")!({}))).success,
    ).toBe(true);
    expect(
      menusSchema.safeParse(
        structured(await handlers.get("get_menus")!({ deliveryId: DELIVERY_ID })),
      ).success,
    ).toBe(true);
    expect(
      itemDetailSchema.safeParse(
        structured(
          await handlers.get("get_menus")!({
            deliveryId: DELIVERY_ID,
            menuId: MENU_ID,
            itemId: ITEM_ID,
          }),
        ),
      ).success,
    ).toBe(true);
    expect(
      recommendationsSchema.safeParse(
        structured(await handlers.get("recommend_meals")!({ deliveryId: DELIVERY_ID })),
      ).success,
    ).toBe(true);
  });

  test("empty reads retain structured collections for MCP Apps", async () => {
    ForkableClient.prototype.query = (async (root: string) =>
      root === "searchMenuItems" ? { nodes: [] } : []) as typeof ForkableClient.prototype.query;
    expect(structured(await handlers.get("get_menus")!({ deliveryId: DELIVERY_ID }))).toEqual({
      menus: [],
    });
    expect(
      structured(
        await handlers.get("search_items")!({ deliveryId: DELIVERY_ID, query: "missing" }),
      ),
    ).toEqual({ items: [] });
    expect(structured(await handlers.get("recommend_meals")!({ deliveryId: DELIVERY_ID }))).toEqual(
      { recommendations: [] },
    );
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: [],
      me: { id: USER_ID },
    })) as typeof ForkableClient.prototype.gql;
    expect(structured(await handlers.get("list_deliveries")!({}))).toEqual({ deliveries: [] });
  });

  test("club policy formatting keeps its text and indentation", async () => {
    const query = ForkableClient.prototype.query;
    ForkableClient.prototype.query = async function (this: ForkableClient, root, args, selection) {
      if (root === "mealClubsAs")
        return [
          {
            id: 7,
            name: "HQ",
            copayAllowance: 25,
            allowanceType: "weekly_by_day",
            deliveryDays: { 1: true, 2: false, 3: true },
            allowLateMeals: true,
            isLateRemovalEnabled: false,
            allowanceMealLimit: true,
            hidePrices: true,
          },
        ];
      return query.call(this, root, args, selection);
    } as typeof ForkableClient.prototype.query;
    const result = await handlers.get("get_profile")!({});
    expect(result.content).toMatchObject([
      {
        type: "text",
        text: expect.stringContaining(
          "Your club:\n  HQ\n    covers $25.00 per delivery day\n    delivery days: Mon Wed\n    late meals allowed; late removals not allowed\n    covers ONE meal a day; any extra is out of pocket\n    (this club hides menu prices)",
        ),
      },
    ]);
  });

  test("profile is human-readable without duplicating the server objects", async () => {
    const result = await handlers.get("get_profile")!({});
    const output = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(output).toContain("Test User");
    expect(output).not.toContain(`id ${USER_ID}`);
    expect(result.structuredContent).toBeUndefined();
  });

  test("delivery lists keep only actionable identity and status", async () => {
    const result = await handlers.get("list_deliveries")!({});
    const item = (structured(result).deliveries as Record<string, unknown>[])[0]!;
    expect(Object.keys(item)).toEqual([
      "deliveryId",
      "date",
      "service",
      "club",
      "status",
      "fulfillment",
      "needsOrder",
      "delayed",
      "trackingUrl",
      "deliveryWindow",
      "reportedDueCents",
      "meals",
    ]);
    expect((item.meals as Record<string, unknown>[])[0]).toEqual({
      pieceId: "piece-1",
      itemId: ITEM_ID,
      menuId: MENU_ID,
      name: "Test Bowl",
      group: "A1",
      isConfirmed: true,
      cancellationPending: true,
      rating: null,
    });
  });

  test("menu reads include photos and exact IDs and choices", async () => {
    const list = await handlers.get("get_menus")!({ deliveryId: DELIVERY_ID });
    const compactMenu = (structured(list).menus as Record<string, unknown>[])[0]!;
    const compactItem = (compactMenu.items as Record<string, unknown>[])[0]!;
    expect(compactMenu).toEqual({
      menuId: MENU_ID,
      name: "Test Kitchen",
      items: [
        {
          itemId: ITEM_ID,
          name: "Test Bowl",
          price: 12.5,
          imageUrl: "https://images.example/bowl.jpg",
          description: "A useful description",
          diet: "vegetarian",
          hasModifiers: true,
        },
      ],
    });
    expect(compactItem.imageUrl).toBe("https://images.example/bowl.jpg");
    expect(compactItem).not.toHaveProperty("dietLevel");

    const detail = await handlers.get("get_menus")!({
      deliveryId: DELIVERY_ID,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(detail).item).toEqual({
      instructionsAllowed: true,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      name: "Test Bowl",
      price: 12.5,
      description: "A useful description",
      imageUrl: "https://images.example/bowl.jpg",
      modifiers: [
        {
          id: 30,
          name: "Protein",
          required: true,
          min: 1,
          max: 1,
          options: [{ id: 31, name: "Tofu", price: 1 }],
        },
      ],
    });
  });

  test("search and recommendations include photos without private scores", async () => {
    const search = await handlers.get("search_items")!({
      deliveryId: DELIVERY_ID,
      query: "bowl",
    });
    expect(structured(search).items).toEqual([
      {
        itemId: ITEM_ID,
        menuId: MENU_ID,
        name: "Test Bowl",
        price: 12.5,
        imageUrl: "https://images.example/bowl.jpg",
      },
    ]);

    const recommendations = await handlers.get("recommend_meals")!({
      deliveryId: DELIVERY_ID,
    });
    expect(structured(recommendations).recommendations).toEqual([
      {
        menuId: MENU_ID,
        itemId: ITEM_ID,
        rank: 1,
        name: "Test Bowl",
        price: 12.5,
        imageUrl: "https://images.example/bowl.jpg",
      },
    ]);
  });

  test("delivery status keeps every tracker without returning the full server snapshot", async () => {
    const result = await handlers.get("get_delivery_status")!({
      deliveryId: DELIVERY_ID,
    });
    expect(structured(result).status).toEqual({
      deliveryId: DELIVERY_ID,
      date: "2026-08-28",
      fulfillment: "delayed",
      delayed: true,
      deliveryWindow: ["11:30 AM", "12:30 PM"],
      timezone: "America/Los_Angeles",
      meals: [
        {
          pieceId: "piece-1",
          orderId: 101,
          name: "Test Bowl",
          price: 12.5,
          options: ["Protein: Tofu"],
          venue: "Test Kitchen",
          group: "A1",
          isConfirmed: true,
          cancellationPending: true,
          rating: null,
        },
        {
          pieceId: "piece-2",
          orderId: 102,
          name: "Second Bowl",
          price: 14,
          options: [],
          venue: "Second Kitchen",
          group: "B2",
          isConfirmed: true,
          cancellationPending: false,
          rating: null,
        },
      ],
      orders: [
        {
          orderId: 101,
          venue: "Test Kitchen",
          fulfillment: "delayed",
          etaStart: "2026-08-28T11:45:00-07:00",
          etaEnd: "2026-08-28T12:00:00-07:00",
          dropoffCompletedAt: null,
          trackingUrl: "https://track.example/101",
        },
        {
          orderId: 102,
          venue: "Second Kitchen",
          fulfillment: "ontime",
          etaStart: "2026-08-28T12:05:00-07:00",
          etaEnd: "2026-08-28T12:20:00-07:00",
          dropoffCompletedAt: null,
          trackingUrl: "https://track.example/102",
        },
      ],
      billing: {
        reportedDueCents: 450,
        allowanceType: "weekly",
        copayAmountCents: 2000,
        weeklyAllowanceCents: 10000,
        weeklyAllowanceAvailableCents: 3550,
        memberClubCopayCents: 1500,
      },
    });
    const output = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(output).toContain("11:45 AM–12:00 PM PT");
    expect(output).toContain("https://track.example/101");
    expect(output).toContain("https://track.example/102");
    expect(output).toContain("123 Main St");
  });
});
