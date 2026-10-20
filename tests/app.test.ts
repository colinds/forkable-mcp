import { menuFiltersSchema } from "@/shared/contracts/menu-filters.ts";
import { selectedMealTotal } from "@/shared/meal-options.ts";
import { createMealReference } from "@/shared/meal-reference.ts";
import { createDraftWriter, mealDraft, supportsEditableDrafts } from "@/app/lib/chat-draft.ts";
import { initialRange, initialLaunch } from "@/app/lib/initial-view.ts";
import { openBrowserInputSchema } from "@/shared/contracts/browser.ts";
import { browserContext, createContextUpdater } from "@/app/lib/model-context.ts";
import {
  defaultFilters,
  visibleMeals,
  restaurantGroups,
  menuView,
} from "@/app/lib/menu-filters.ts";
import { fulfillmentLabel, arrivalTime } from "@/app/lib/delivery-labels.ts";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { registerMealBrowser, APP_URI, MEAL_BROWSER_INSTRUCTIONS } from "@/server/ui-server.ts";
import { Confirmation, data, selectionArgs, type CallTool } from "@/app/lib/tools.ts";
import { imageUrl } from "@/shared/images.ts";
import { menusSchema, type Delivery, type Detail } from "@/shared/contracts/meals.ts";

const delivery: Delivery = {
  deliveryId: 1,
  date: "2026-10-05",
  service: "lunch",
  club: "Office",
  status: "scheduled",
  fulfillment: null,
  meals: [
    { pieceId: "a", menuId: 10, itemId: 7, name: "First meal", cancellationPending: false },
    { pieceId: "b", menuId: 20, itemId: 7, name: "Second meal", cancellationPending: false },
  ],
};
const detail: Detail = {
  menuId: 2,
  itemId: 3,
  name: "Bowl",
  price: 15,
  imageUrl: null,
  description: null,
  modifiers: [
    {
      id: 4,
      name: "Protein",
      required: true,
      min: 1,
      max: 1,
      options: [{ id: 5, name: "Tofu", price: 0 }],
    },
  ],
};
describe("meal browser", () => {
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
  test("requires exact owned replacement target and required options", () => {
    expect(() => selectionArgs(delivery, detail, "", { 4: [5] })).toThrow("meal to replace");
    expect(() => selectionArgs(delivery, detail, "b", {})).toThrow("Protein");
    expect(selectionArgs(delivery, detail, "b", { 4: [5] })).toEqual({
      deliveryId: 1,
      menuId: 2,
      itemId: 3,
      mode: "set",
      sourcePieceId: "b",
      modifiers: [{ modifier: 4, options: [5] }],
    });
    expect(selectionArgs({ ...delivery, meals: [] }, detail, "", { 4: [5] })).not.toHaveProperty(
      "sourcePieceId",
    );
  });
  test("only permits the verified photo origin", () => {
    expect(imageUrl("https://cdn.filestackcontent.com/meal")).toBeTruthy();
    for (const url of [
      null,
      "javascript:alert(1)",
      "https://cdn.filestackcontent.com.evil.test/a",
      "http://cdn.filestackcontent.com/a",
    ])
      expect(imageUrl(url)).toBeUndefined();
  });
  test("confirmation consumes exact preview once and never retries an uncertain response", async () => {
    const gate = new Confirmation();
    const calls: Record<string, unknown>[] = [];
    const call: CallTool = async (_name, args) => {
      calls.push(args);
      return {
        structuredContent:
          "confirmToken" in args && args.confirmToken
            ? { mode: "outcome_unknown" }
            : {
                mode: "preview",
                summary: "Fixture preview",
                confirmToken: "token",
                expiresAt: new Date(Date.now() + 10000).toISOString(),
              },
      };
    };
    const args = { deliveryId: 3, menuId: 1, itemId: 2 };
    await gate.preview(call, args);
    args.menuId = 99;
    await gate.confirm(call);
    expect(calls[1]).toEqual({ deliveryId: 3, menuId: 1, itemId: 2, confirmToken: "token" });
    await expect(gate.confirm(call)).rejects.toThrow("expired");
    expect(calls).toHaveLength(2);
  });
  test("expired, cleared and rejected previews cannot execute", async () => {
    const gate = new Confirmation();
    const call: CallTool = async () => ({
      structuredContent: {
        mode: "preview",
        summary: "Fixture preview",
        confirmToken: "token",
        expiresAt: new Date(gate.pending?.expiresAt ?? 0).toISOString(),
      },
    });
    await gate.preview(call, { deliveryId: 3, menuId: 1, itemId: 2 });
    await expect(gate.confirm(call)).rejects.toThrow("expired");
    await gate.preview(async () => ({ isError: true, structuredContent: { mode: "rejected" } }), {
      deliveryId: 3,
      menuId: 1,
      itemId: 2,
    });
    expect(gate.pending).toBeUndefined();
    await gate.preview(call, { deliveryId: 3, menuId: 1, itemId: 2 });
    gate.clear();
    await expect(gate.confirm(call)).rejects.toThrow("expired");
  });
});

test("malformed tool data fails at the boundary instead of entering UI state", () => {
  expect(() => data({ structuredContent: { menus: [{ menuId: 1 }] } }, menusSchema)).toThrow(
    "unexpected response",
  );
  expect(data({ structuredContent: { menus: [] } }, menusSchema)).toEqual({ menus: [] });
});

test("delivery labels distinguish order lifecycle from courier ETA", () => {
  expect(fulfillmentLabel("initial")).toBe("Awaiting delivery updates");
  expect(fulfillmentLabel("ontime")).toBe("Arriving On Time");
  expect(fulfillmentLabel("delivered")).toBe("Delivered");
  expect(fulfillmentLabel("something-new")).toBe("Delivery status unavailable");
  expect(arrivalTime("2026-10-05T18:50:00Z", "America/Los_Angeles")).toBe("11:50 AM PDT");
  expect(arrivalTime("2026-10-05T11:50:00-07:00", null)).toBe("11:50 AM UTC-07:00");
});

test("search matches description tokens and filters unknown prices conservatively", () => {
  const menus = [
    {
      menuId: 10,
      name: "Café Kitchen",
      items: [
        {
          itemId: 1,
          name: "Bowl",
          description: "Fresh mango",
          price: 12,
          imageUrl: null,
          diet: "Vegetarian",
        },
        { itemId: 2, name: "Chicken", price: null, imageUrl: null, diet: "Omnivore" },
      ],
    },
  ];
  expect(
    visibleMeals(menus, [], "cafe mango", defaultFilters).map((row) => row.item.itemId),
  ).toEqual([1]);
  expect(
    visibleMeals(menus, [], "", { ...defaultFilters, maxPrice: 20 }).map((row) => row.item.itemId),
  ).toEqual([1]);
  expect(visibleMeals(menus, [], "", { ...defaultFilters, recommendedOnly: true })).toEqual([]);
  expect(
    visibleMeals(menus, [], "", { ...defaultFilters, diet: "Omnivore" }).map(
      (row) => row.item.itemId,
    ),
  ).toEqual([2]);
});
test("model context contains view identity and filters, never confirmation credentials", () => {
  const state = {
    delivery,
    detail,
    query: "fruit",
    source: "b",
    menus: [],
    choices: { 4: [5] },
    needsRefresh: false,
    filters: defaultFilters,
    recommendations: [],
    preview: { confirmToken: "do-not-share" },
    cookie: "do-not-share",
  };
  const context = browserContext(state, menuView(state));
  expect(context.structuredContent).toMatchObject({
    delivery: { deliveryId: 1 },
    focusedMeal: { menuId: 2, itemId: 3 },
    search: "fruit",
  });
  expect(JSON.stringify(context)).not.toContain("do-not-share");
  expect(
    browserContext({ ...state, detail: undefined }, menuView(state)).structuredContent?.focusedMeal,
  ).toBeNull();
});

test("restaurant grouping keeps identities and sorts within groups rather than mixing menus", () => {
  const menus = [
    {
      menuId: 1,
      name: "Kitchen A",
      items: [{ itemId: 7, name: "First", price: 12, imageUrl: null }],
    },
    {
      menuId: 2,
      name: "Kitchen B",
      items: [{ itemId: 7, name: "Second", price: 20, imageUrl: null }],
    },
    {
      menuId: 3,
      name: "Kitchen A",
      items: [{ itemId: 7, name: "Third", price: 15, imageUrl: null }],
    },
  ];
  const items = visibleMeals(menus, [], "", { ...defaultFilters, sort: "price-high" });
  expect(items.map((row) => row.menu.menuId)).toEqual([2, 3, 1]);
  expect(
    restaurantGroups(menus, items).map((group) => [
      group.name,
      group.items.map((row) => row.menu.menuId),
    ]),
  ).toEqual([
    ["Kitchen A", [3, 1]],
    ["Kitchen B", [2]],
  ]);
});

const statusLaunchSeed = (date: string) => ({
  input: {},
  result: {
    structuredContent: {
      status: {
        deliveryId: 1,
        date,
        fulfillment: null,
        delayed: false,
        deliveryWindow: null,
        timezone: null,
        meals: [],
        orders: [],
        billing: { reportedDueCents: null },
      },
    },
  },
});

test("status launches bound historical dates but keep the upcoming date strip", () => {
  expect(initialRange(statusLaunchSeed("2026-10-14"), "2026-10-12")).toEqual({});
  expect(initialRange(statusLaunchSeed("2026-10-12"), "2026-10-12")).toEqual({});
  expect(initialRange(statusLaunchSeed("2020-01-02"), "2026-10-12")).toEqual({
    from: "2020-01-02",
    to: "2020-01-02",
  });
});

test("exact meal launches require the delivery and both item identifiers", () => {
  expect(openBrowserInputSchema.safeParse({ menuId: 10, itemId: 7 }).success).toBe(false);
  expect(openBrowserInputSchema.safeParse({ deliveryId: 1, itemId: 7 }).success).toBe(false);
  expect(openBrowserInputSchema.safeParse({ deliveryId: 1, menuId: 10 }).success).toBe(false);
  expect(openBrowserInputSchema.safeParse({ deliveryId: 1, menuId: 10, itemId: 7 }).success).toBe(
    true,
  );
  expect(openBrowserInputSchema.safeParse({ deliveryId: 1 }).success).toBe(true);
  expect(openBrowserInputSchema.safeParse({}).success).toBe(true);
});

test("chat context uses the same ordered menu view and caps its meal projection", () => {
  const menus = ["Second Restaurant", "First Restaurant"].map((name, index) => ({
    menuId: index + 1,
    name,
    items: Array.from({ length: 20 }, (_, itemId) => ({
      itemId,
      name: `Meal ${itemId}`,
      price: itemId,
      imageUrl: null,
    })),
  }));
  const filters = { ...defaultFilters, sort: "price-high" as const };
  const view = menuView({ menus, recommendations: [], query: "", filters });
  const context = browserContext(
    {
      query: "",
      filters,
      choices: {},
      source: "",
      needsRefresh: false,
    },
    view,
  ).structuredContent!;
  expect(context.totalMatchingMeals).toBe(40);
  expect(context.visibleMeals).toEqual(
    view.ordered.slice(0, 30).map(({ menu, item }) => ({
      menuId: menu.menuId,
      itemId: item.itemId,
      name: item.name,
      restaurant: menu.name,
      price: item.price,
    })),
  );
  expect(view.restaurants.map((group) => group.name)).toEqual(menus.map((menu) => menu.name));
});

test("restored context does not suppress returning to an earlier view", async () => {
  const sent: unknown[] = [];
  const a = { content: [], structuredContent: { search: "curry" } };
  const b = { content: [], structuredContent: { search: "tofu" } };
  const update = createContextUpdater({
    getHostCapabilities: () => ({ updateModelContext: { structuredContent: {} } }),
    getHostContext: () => ({ "openai/modelContext": a }),
    updateModelContext: async (value) => {
      sent.push(value);
      return {};
    },
  });
  await update(a);
  await update(b);
  await update(a);
  await update(a);
  expect(sent).toEqual([b, a]);
});

test("selected meal total includes chosen options and preserves an unknown base price", () => {
  const meal: Detail = {
    ...detail,
    price: 15,
    modifiers: [
      {
        id: 3,
        name: "Sides",
        required: false,
        min: 0,
        max: 2,
        options: [
          { id: 4, name: "Kimchi", price: 1 },
          { id: 5, name: "Rice", price: 0.5 },
        ],
      },
    ],
  };
  expect(selectedMealTotal(meal, {})).toBe(15);
  expect(selectedMealTotal(meal, { 3: [4, 5] })).toBe(16.5);
  expect(selectedMealTotal(meal, { 3: [5] })).toBe(15.5);
  expect(selectedMealTotal({ ...meal, price: null }, { 3: [4] })).toBeUndefined();
});

describe("editable meal drafts", () => {
  test("includes exact meal identity and selected options without copying private state", () => {
    const selection = {
      delivery,
      detail,
      restaurant: "Fixture restaurant",
      choices: { 4: [5] },
      source: "b",
      confirmToken: "private-confirmation-token",
    };
    const draft = mealDraft(createMealReference(selection));
    expect(draft["_meta"]?.["openai/message"]).toEqual({ target: "active", send: false });
    expect(draft.content).toHaveLength(2);
    const attachment = draft.content[1]!;
    expect(attachment["_meta"]?.["openai/title"]).toBe("Bowl · Fixture restaurant · Mon, Oct 5");
    const text = JSON.stringify(draft);
    expect(text).toContain("Fixture restaurant");
    expect(text).toContain("Protein: Tofu");
    expect(text).toContain("$15.00");
    expect(text).not.toContain("private-confirmation-token");
    expect(attachment.type).toBe("text");
    if (attachment.type === "text") {
      const reference = JSON.parse(attachment.text.split("Forkable reference: ")[1]!);
      expect(reference).toEqual({
        uri: "forkable://delivery/1/menu/2/item/3",
        deliveryId: 1,
        menuId: 2,
        itemId: 3,
        modifiers: [{ modifier: 4, options: [5] }],
        sourcePieceId: "b",
      });
    }
  });

  test("questions can be drafted before choosing required options or a replacement", () => {
    const draft = mealDraft(
      createMealReference({
        delivery,
        detail: { ...detail, price: null },
        choices: {},
        source: "",
      }),
    );
    const text = JSON.stringify(draft);
    expect(text).toContain("None selected");
    expect(text).toContain("Price unavailable");
    expect(text).not.toContain("sourcePieceId");
    expect(createMealReference({ delivery, detail }).modifiers).toEqual([]);
    expect(createMealReference({ delivery, detail, choices: { 4: [] } }).modifiers).toEqual([
      { modifier: 4, options: [] },
    ]);
  });

  test("checks host support again at the time of the action", async () => {
    let platform: "desktop" | "web" | "mobile" = "desktop";
    const messages: unknown[] = [];
    const host = {
      getHostContext: () => ({ platform }),
      getHostCapabilities: () => ({
        experimental: { "openai/message": {} },
        message: { text: {} },
      }),
      sendMessage: async (message: unknown) => {
        messages.push(message);
        return {};
      },
    };
    expect(supportsEditableDrafts(host)).toBe(true);
    const write = createDraftWriter(host);
    platform = "mobile";
    expect(supportsEditableDrafts(host)).toBe(false);
    await expect(
      write(createMealReference({ delivery, detail, choices: {}, source: "" })),
    ).rejects.toThrow("unavailable");
    expect(messages).toHaveLength(0);
    platform = "web";
    await write(createMealReference({ delivery, detail, choices: {}, source: "" }));
    expect(messages).toHaveLength(1);
  });

  test("host failures are not retried or converted to sent messages", async () => {
    let calls = 0;
    const write = createDraftWriter({
      getHostContext: () => ({ platform: "desktop" }),
      getHostCapabilities: () => ({
        experimental: { "openai/message": {} },
        message: { text: {} },
      }),
      sendMessage: async () => {
        calls++;
        return { isError: true };
      },
    });
    await expect(
      write(createMealReference({ delivery, detail, choices: {}, source: "" })),
    ).rejects.toThrow("Check the chat composer");
    expect(calls).toBe(1);
  });
});

test("drafts and background context share the same meal reference", () => {
  const state = {
    delivery,
    detail,
    choices: { 4: [5] },
    source: "b",
    query: "tofu",
    filters: defaultFilters,
    needsRefresh: false,
  };
  const meal = createMealReference(state);
  const context = browserContext(
    state,
    menuView({ menus: [], recommendations: [], query: state.query, filters: state.filters }),
  );
  expect(context.structuredContent?.focusedMeal).toEqual(meal);
  expect(meal.uri).toBe("forkable://delivery/1/menu/2/item/3");
  const attachment = mealDraft(meal).content[1]!;
  if (attachment.type !== "text") throw new Error("Expected a meal attachment");
  expect(attachment.text).toContain(meal.uri);
  expect(attachment.text).toContain(JSON.stringify(meal.modifiers));
});

test("all browser filters share the UI defaults and validate model inputs", () => {
  expect(menuFiltersSchema.parse({})).toEqual(defaultFilters);
  const filters = {
    restaurantId: 10,
    diet: "Vegetarian",
    maxPrice: 0,
    recommendedOnly: true,
    sort: "price-high" as const,
  };
  expect(openBrowserInputSchema.parse({ filters }).filters).toEqual(filters);
  expect(openBrowserInputSchema.parse({ filters: { maxPrice: 18 } }).filters).toEqual({
    ...defaultFilters,
    maxPrice: 18,
  });
  for (const invalid of [
    { maxPrice: -1 },
    { maxPrice: Infinity },
    { restaurantId: 1.5 },
    { sort: "unknown" },
  ]) {
    expect(openBrowserInputSchema.safeParse({ filters: invalid }).success).toBe(false);
  }
});

test("inline results sort globally while the full browser keeps restaurant grouping", () => {
  const menus = [
    {
      menuId: 10,
      name: "First kitchen",
      items: [
        { itemId: 1, name: "Expensive", price: 30, imageUrl: null },
        { itemId: 2, name: "Cheap", price: 10, imageUrl: null },
      ],
    },
    {
      menuId: 20,
      name: "Second kitchen",
      items: [{ itemId: 3, name: "Middle", price: 20, imageUrl: null }],
    },
  ];
  const browse = menuView({ menus, recommendations: [], query: "", filters: defaultFilters });
  expect(browse.layout).toBe("restaurants");
  const results = menuView({
    menus,
    recommendations: [],
    query: "",
    filters: menuFiltersSchema.parse({ sort: "price-low" }),
    layout: "results",
  });
  expect(results.layout).toBe("results");
  expect(results.ordered.map((row) => row.item.price)).toEqual([10, 20, 30]);
});

test("launch intent selects a presentation independently of host display mode", () => {
  const result = (structuredContent: Record<string, unknown>, input = {}) => ({
    input,
    result: { structuredContent },
  });
  expect(initialLaunch(result({})).view).toBe("browse");
  expect(initialLaunch(result({}, { deliveryId: 1 })).view).toBe("delivery");
  expect(
    initialLaunch(result({ deliveries: [delivery, { ...delivery, deliveryId: 2 }] })),
  ).toMatchObject({ view: "delivery", showDates: true });
  expect(initialLaunch(statusLaunchSeed("2026-10-19"))).toMatchObject({
    view: "delivery",
    showDates: false,
  });
  expect(initialLaunch(result({ menus: [] })).view).toBe("meals");
  expect(initialLaunch(result({ items: [] })).view).toBe("meals");
  expect(initialLaunch(result({ item: detail })).view).toBe("meals");
  expect(initialLaunch(result({}, { query: "curry" })).view).toBe("meals");
  expect(initialLaunch(result({}, { view: "meals" })).view).toBe("meals");
  expect(initialLaunch(result({ menus: [] }, { view: "browse" })).view).toBe("browse");
  expect(initialLaunch(result({ recommendations: [] }, { limit: 3 }))).toMatchObject({
    view: "meals",
    limit: 3,
    filters: { ...defaultFilters, recommendedOnly: true },
  });
});

test("delivery context does not claim that hidden menus are visible", () => {
  const view = menuView({
    menus: [{ menuId: 2, name: "Kitchen", items: [{ ...detail }] }],
    recommendations: [],
    query: "",
    filters: defaultFilters,
  });
  const context = browserContext(
    {
      presentation: "delivery",
      delivery,
      query: "",
      choices: {},
      source: "",
      filters: defaultFilters,
      needsRefresh: false,
    },
    view,
  ).structuredContent;
  expect(context).toMatchObject({ view: "delivery", visibleMeals: [], totalMatchingMeals: 0 });
});
