import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { patchSession } from "@/auth/session.ts";
import { ForkableClient } from "@/net/client.ts";
import { type Delivery, type Menu } from "@/order/types.ts";
import { registerAllTools } from "@/tools.ts";
import { createWriteGate } from "@/write-gate.ts";

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
  isReadOnly: true,
  pastLateOrderDeadline: true,
  canRequestChanges: false,
  allowanceType: "weekly",
  copayAmount: 20,
  weeklyAllowance: 100,
  weeklyAllowanceAvailable: 35.5,
  serviceWindow: { name: "lunch" },
  deliveryWindow: ["11:30 AM", "12:30 PM"],
  club: { id: 7, name: "HQ", market: { timezone: "America/Los_Angeles" } },
  address: { formatted: "123 Main St", notes: "Use the side door" },
  userReceipt: { id: 201, due: 4.5, clubCopay: 15 },
  orders: [
    {
      id: 101,
      venue: { id: 301, displayName: "Test Kitchen" },
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
          autoOrder: true,
          isRemoval: true,
          requestStatus: "pending",
          nonHiddenAttributes: [{ label: "Protein", value: "Tofu" }],
        },
      ],
    },
    {
      id: 102,
      venue: { id: 302, displayName: "Second Kitchen" },
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
      id: 1,
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
    });
  });

  test("menu reads keep exact IDs and choices without media or policy fields", async () => {
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
          diet: "vegetarian",
          hasModifiers: true,
        },
      ],
    });
    expect(compactItem).not.toHaveProperty("imageUrl");
    expect(compactItem).not.toHaveProperty("dietLevel");

    const detail = await handlers.get("get_menus")!({
      deliveryId: DELIVERY_ID,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(detail).item).toEqual({
      menuId: MENU_ID,
      itemId: ITEM_ID,
      name: "Test Bowl",
      price: 12.5,
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

  test("search and recommendation results omit image URLs and private scores", async () => {
    const search = await handlers.get("search_items")!({
      deliveryId: DELIVERY_ID,
      query: "bowl",
    });
    expect(structured(search).items).toEqual([
      { itemId: ITEM_ID, menuId: MENU_ID, name: "Test Bowl", price: 12.5 },
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
      },
    ]);
  });

  test("pick explanations report ranks rather than raw scores", async () => {
    const result = await handlers.get("explain_pick")!({
      deliveryId: DELIVERY_ID,
    });
    expect(structured(result)).toEqual({
      picked: [
        { itemId: ITEM_ID, menuId: MENU_ID, name: "Test Bowl", rank: 1 },
        {
          itemId: ITEM_ID + 1,
          menuId: MENU_ID + 1,
          name: "Second Bowl",
          rank: null,
        },
      ],
      top: [{ menuId: MENU_ID, itemId: ITEM_ID, rank: 1, name: "Test Bowl" }],
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("score");
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
