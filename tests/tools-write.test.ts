import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { patchSession } from "@/auth/session.ts";
import { ForkableClient } from "@/net/client.ts";
import { type Delivery, type Menu } from "@/order/types.ts";
import { registerAllTools } from "@/tools.ts";
import { createWriteGate } from "@/write-gate.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const USER_ID = 42;
const MENU_ID = 10;
const ITEM_ID = 20;

function menu(price: number | null = 12.5): Menu {
  return {
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
            price: price ?? undefined,
            modifiers: [],
          },
        ],
      },
    ],
  };
}

function delivery(
  id: number,
  pieces: NonNullable<Delivery["orders"]>[number]["pieces"] = [],
): Delivery {
  return {
    id,
    availableMenuIds: [MENU_ID],
    orders: [{ id: id * 100, menu: { id: MENU_ID }, pieces }],
  };
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe("write tool planning", () => {
  let home: string;
  let deliveries: Delivery[];
  let menus: Menu[];
  let dietChecks: number;
  let dietResponse: string[] | Error;
  let handlers: Map<string, ToolHandler>;
  let mutations: {
    name: string;
    selection: string;
    input: Record<string, unknown>;
  }[];
  let originalGql: typeof ForkableClient.prototype.gql;
  let originalMutate: typeof ForkableClient.prototype.mutate;
  let originalQuery: typeof ForkableClient.prototype.query;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "forkable-tools-write-"));
    process.env.FORKABLE_MCP_HOME = home;
    delete process.env.FORKABLE_MAX_TOTAL;
    await patchSession({ cookie: "_easyorder_session=test", csrf: "test-csrf" });

    deliveries = [delivery(1)];
    menus = [menu()];
    dietChecks = 0;
    dietResponse = [];
    mutations = [];

    originalGql = ForkableClient.prototype.gql;
    originalMutate = ForkableClient.prototype.mutate;
    originalQuery = ForkableClient.prototype.query;
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: deliveries,
      me: { id: USER_ID },
    })) as typeof ForkableClient.prototype.gql;
    ForkableClient.prototype.query = (async (root: string) => {
      if (root === "me") return { id: USER_ID };
      if (root === "menus") return menus;
      if (root === "mealRestrictions") {
        dietChecks++;
        if (dietResponse instanceof Error) throw dietResponse;
        return { conflicts: dietResponse };
      }
      throw new Error(`unexpected query: ${root}`);
    }) as typeof ForkableClient.prototype.query;
    ForkableClient.prototype.mutate = (async (
      name: string,
      selection: string,
      input: Record<string, unknown>,
    ) => {
      mutations.push({ name, selection, input });
      return { ok: true };
    }) as typeof ForkableClient.prototype.mutate;

    handlers = new Map();
    const server = {
      registerTool(name: string, _definition: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    let token = 0;
    registerAllTools(
      server,
      createWriteGate({ randomToken: () => `test-token-${++token}`, now: () => 1_000 }),
    );
  });

  afterEach(() => {
    ForkableClient.prototype.gql = originalGql;
    ForkableClient.prototype.mutate = originalMutate;
    ForkableClient.prototype.query = originalQuery;
    delete process.env.FORKABLE_MCP_HOME;
    delete process.env.FORKABLE_MAX_TOTAL;
    rmSync(home, { recursive: true, force: true });
  });

  test("requires an exact menu and item pair", async () => {
    menus.push({
      id: MENU_ID + 1,
      sections: [
        {
          id: 2,
          items: [{ id: ITEM_ID, menuId: MENU_ID + 1, name: "Other Bowl", modifiers: [] }],
        },
      ],
    });
    const exact = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(exact).mode).toBe("preview");
    expect(structured(exact)).not.toHaveProperty("variables");
    await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      modifiers: [],
      instructions: "",
      autoConfirm: false,
      confirmToken: structured(exact).confirmToken,
    });
    expect(mutations[0]?.input.menuId).toBe(MENU_ID);

    const result = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID + 2,
      itemId: ITEM_ID,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).confirmToken).toBeUndefined();
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      `Item ${ITEM_ID} was not found on menu ${MENU_ID + 2}`,
    );
  });

  test("does not turn a missing actor identity into an empty meal", async () => {
    ForkableClient.prototype.gql = (async () => ({
      myDeliveries: [delivery(1)],
    })) as typeof ForkableClient.prototype.gql;
    const result = await handlers.get("list_deliveries")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Forkable did not report your user id",
    );
  });

  test("uses a positively owned source piece without sending sourcePieceId", async () => {
    deliveries = [
      delivery(1, [{ id: "mine", itemId: 1, menuId: MENU_ID, userId: USER_ID, name: "Old Bowl" }]),
    ];
    const result = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      sourcePieceId: "mine",
      instructions: "no onions",
    });
    expect(structured(result).mode).toBe("preview");
    expect(structured(result).summary).toContain("Replace Old Bowl with Test Bowl");
    expect(structured(result).summary).toContain('instructions: "no onions"');
    await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      sourcePieceId: "mine",
      modifiers: [],
      instructions: "no onions",
      autoConfirm: false,
      confirmToken: structured(result).confirmToken,
    });
    expect(mutations[0]?.input.oldPieceId).toBe("mine");
    expect(mutations[0]?.input).not.toHaveProperty("sourcePieceId");

    deliveries = [delivery(1, [{ id: "theirs", itemId: 1, menuId: MENU_ID, userId: USER_ID + 1 }])];
    const foreign = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      sourcePieceId: "theirs",
    });
    expect(foreign.isError).toBe(true);
    expect(structured(foreign).confirmToken).toBeUndefined();

    deliveries = [
      delivery(1, [
        { id: "first", itemId: 1, menuId: MENU_ID, userId: USER_ID },
        { id: "second", itemId: 2, menuId: MENU_ID, userId: USER_ID },
      ]),
    ];
    const ambiguous = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(ambiguous.isError).toBe(true);
    expect(structured(ambiguous).confirmToken).toBeUndefined();
  });

  test("deduplicates a batch and runs Forkable's diet check once", async () => {
    deliveries = [delivery(1), delivery(2)];
    const result = await handlers.get("set_meal_all")!({
      deliveryIds: [1, 1, 2],
      menuId: MENU_ID,
      itemId: ITEM_ID,
      instructions: "sauce on the side",
    });
    expect(structured(result).mode).toBe("preview");
    expect(structured(result).summary).toContain('instructions: "sauce on the side"');
    expect(dietChecks).toBe(1);
    const confirmed = await handlers.get("set_meal_all")!({
      deliveryIds: [1, 2],
      menuId: MENU_ID,
      itemId: ITEM_ID,
      modifiers: [],
      instructions: "sauce on the side",
      confirmToken: structured(result).confirmToken,
    });
    expect(structured(confirmed).mode).toBe("executed");
    expect(mutations).toEqual([
      expect.objectContaining({
        name: "replaceAllPieces",
        selection: "errors",
        input: expect.objectContaining({
          deliveryIds: [1, 2],
          newPiece: expect.objectContaining({
            deliveryId: 1,
            menuId: MENU_ID,
            itemId: ITEM_ID,
          }),
        }),
      }),
    ]);
    expect(dietChecks).toBe(1);

    deliveries = [
      delivery(1, [
        { id: "first", itemId: 1, menuId: MENU_ID, userId: USER_ID },
        { id: "second", itemId: 2, menuId: MENU_ID, userId: USER_ID },
      ]),
    ];
    const ambiguous = await handlers.get("set_meal_all")!({
      deliveryIds: [1],
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(ambiguous.isError).toBe(true);
    expect(structured(ambiguous).confirmToken).toBeUndefined();
    expect(dietChecks).toBe(1);
  });

  test("surfaces dietary conflicts and an unavailable check without blocking", async () => {
    dietResponse = ["shellfish"];
    const conflict = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(conflict).mode).toBe("preview");
    expect(structured(conflict).warnings).toEqual([
      expect.objectContaining({ code: "diet_conflict" }),
    ]);
    expect(dietChecks).toBe(1);
    const confirmed = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
      modifiers: [],
      instructions: "",
      autoConfirm: false,
      confirmToken: structured(conflict).confirmToken,
    });
    expect(structured(confirmed).mode).toBe("executed");
    expect(dietChecks).toBe(1);

    dietResponse = new Error("diet service unavailable");
    const unavailable = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(unavailable).mode).toBe("preview");
    expect(structured(unavailable).warnings).toEqual([
      expect.objectContaining({ code: "diet_check_unavailable" }),
    ]);
    expect(dietChecks).toBe(2);
  });

  test("remove and skip require positive ownership", async () => {
    deliveries = [delivery(1, [{ id: "theirs", itemId: 1, menuId: MENU_ID, userId: USER_ID + 1 }])];
    const results = await Promise.all([
      handlers.get("remove_meal")!({ deliveryId: 1, pieceId: "theirs" }),
      handlers.get("skip_delivery")!({ deliveryId: 1 }),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(structured(result).confirmToken).toBeUndefined();
    }
  });

  test("skip explains how to remove multiple positively owned meals", async () => {
    deliveries = [
      delivery(1, [
        { id: "first", itemId: 1, menuId: MENU_ID, userId: USER_ID },
        { id: "second", itemId: 2, menuId: MENU_ID, userId: USER_ID },
      ]),
    ];
    const ambiguous = await handlers.get("skip_delivery")!({ deliveryId: 1 });
    const message = ambiguous.content[0]?.type === "text" ? ambiguous.content[0].text : "";
    expect(ambiguous.isError).toBe(true);
    expect(structured(ambiguous).confirmToken).toBeUndefined();
    expect(message).toContain("remove_meal");
    expect(message).toContain("pieceId");
    expect(message).not.toContain("sourcePieceId");
    expect(mutations).toEqual([]);

    deliveries = [
      delivery(1, [
        { id: "mine", itemId: 1, menuId: MENU_ID, userId: USER_ID },
        { id: "theirs", itemId: 2, menuId: MENU_ID, userId: USER_ID + 1 },
        { id: "unknown", itemId: 3, menuId: MENU_ID },
      ]),
    ];
    const oneOwned = await handlers.get("skip_delivery")!({ deliveryId: 1 });
    expect(structured(oneOwned).mode).toBe("preview");
  });

  test("blocks unknown prices only when a preview ceiling is configured", async () => {
    menus = [menu(null)];
    const withoutCeiling = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(withoutCeiling).mode).toBe("preview");
    expect(structured(withoutCeiling)).not.toHaveProperty("details");
    expect(
      withoutCeiling.content[0]?.type === "text" ? withoutCeiling.content[0].text : "",
    ).toContain("price unavailable");

    process.env.FORKABLE_MAX_TOTAL = "20";
    const withCeiling = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(withCeiling).mode).toBe("blocked");
    expect(structured(withCeiling).blockers).toEqual([
      expect.objectContaining({ code: "price_unknown_for_ceiling" }),
    ]);
  });

  test("honors an explicit zero-dollar preview ceiling", async () => {
    process.env.FORKABLE_MAX_TOTAL = "0";
    const result = await handlers.get("set_meal")!({
      deliveryId: 1,
      menuId: MENU_ID,
      itemId: ITEM_ID,
    });
    expect(structured(result).mode).toBe("blocked");
    expect(structured(result).blockers).toEqual([
      expect.objectContaining({ code: "over_total_ceiling" }),
    ]);
  });

  test("does not render an unknown menu price as zero", async () => {
    menus = [menu(null)];
    const result = await handlers.get("get_menus")!({ deliveryId: 1 });
    const output = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(output).toContain("price unavailable");
    expect(output).not.toContain("$0.00");
  });
});
