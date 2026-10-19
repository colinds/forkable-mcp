// Test host uses the real MCP Apps bridge with deterministic meal fixtures; never real credentials.
import type { McpUiStyles } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const params = new URLSearchParams(location.search);
const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
const contextUpdates: unknown[] = [];
Object.assign(window, { calls, contextUpdates });
const pendingAux: (() => void)[] = [];
Object.assign(window, { releaseAux: () => pendingAux.splice(0).forEach((release) => release()) });
let changed = false;
const item = {
  itemId: 7,
  name: "Spicy tofu bowl",
  price: 15,
  imageUrl: "https://cdn.filestackcontent.com/test-photo",
  diet: "Vegetarian",
  description: "Tofu with mango, pineapple and chili",
};
function searchItems() {
  if (params.has("no-matches")) return [];
  if (params.has("many-matches"))
    return Array.from({ length: 17 }, (_, index) => ({ menuId: 10, itemId: index + 100 }));
  return [{ menuId: 20, itemId: 7 }];
}
const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
const bridge = new AppBridge(
  null,
  { name: "Fixture host", version: "0" },
  {
    serverTools: {},
    ...(params.has("context")
      ? {
          updateModelContext: params.has("text-context")
            ? { text: {} }
            : { text: {}, structuredContent: {} },
        }
      : {}),
  },
  {
    hostContext: {
      ...(params.has("restore-context")
        ? {
            "openai/modelContext": JSON.parse(
              sessionStorage.getItem("forkable-fixture-context") ?? "null",
            ),
          }
        : {}),
      theme: "light",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      styles: {
        variables: {
          "--color-background-primary": "#ffffff",
          "--color-text-primary": "#202020",
        } as McpUiStyles,
      },
    },
  },
);
let displayMode = "inline";
Object.assign(window, {
  changeDisplayMode: (mode: "inline" | "fullscreen") => {
    displayMode = mode;
    bridge.setHostContext({ displayMode: mode });
  },
});
const sizes: number[] = [];
Object.assign(window, { sizes });
bridge.addEventListener("sizechange", ({ height }) => {
  if (height == null || displayMode === "fullscreen") return;
  sizes.push(height);
  if (params.has("auto-size") && !params.has("clamp-size")) frame.style.height = `${height}px`;
  if (params.has("clamp-size"))
    bridge.setHostContext({ containerDimensions: { width: 1000, height: 1600 } });
});
bridge.onupdatemodelcontext = async (context) => {
  if (params.has("text-context") && context.structuredContent)
    throw new Error("Host accepts text context only");
  contextUpdates.push(context);
  if (params.has("restore-context")) {
    const restored = { ...context, updateId: `context-${contextUpdates.length}` };
    sessionStorage.setItem("forkable-fixture-context", JSON.stringify(restored));
    bridge.setHostContext({ "openai/modelContext": restored });
  }
  return {};
};
const respond = async (
  args: Parameters<NonNullable<AppBridge["oncalltool"]>>[0],
): ReturnType<NonNullable<AppBridge["oncalltool"]>> => {
  calls.push({ name: args.name, arguments: args.arguments });
  const refreshFailure = params.get("refresh-failure");
  const count = calls.filter((call) => call.name === args.name).length;
  if (
    (refreshFailure === "list" && args.name === "list_deliveries" && count === 3) ||
    (refreshFailure === "search" && args.name === "search_items" && count === 1)
  ) {
    return { isError: true, content: [{ type: "text", text: "Temporary search refresh failure" }] };
  }
  if (
    params.has("slow-aux") &&
    args.arguments?.deliveryId === 1 &&
    ["recommend_meals", "get_delivery_status"].includes(args.name)
  ) {
    await new Promise<void>((resolve) => pendingAux.push(resolve));
  }
  if (params.has("aux-error") && ["recommend_meals", "get_delivery_status"].includes(args.name)) {
    return { isError: true, content: [{ type: "text", text: "Auxiliary read unavailable" }] };
  }
  if (params.has("error"))
    return {
      isError: true,
      content: [{ type: "text", text: "Forkable session expired. Sign in again." }],
    };
  let result: Record<string, unknown> = {};
  if (args.name === "list_deliveries")
    result = {
      deliveries: params.has("empty")
        ? []
        : [
            {
              deliveryId: 1,
              date: "2026-10-05",
              service: "Lunch",
              club: "Office",
              status: "confirmed",
              fulfillment: "initial",
              meals: [
                {
                  pieceId: "a",
                  menuId: 10,
                  itemId: 7,
                  cancellationPending: false,
                  name: changed ? item.name : "Chicken rice bowl",
                },
                { pieceId: "b", menuId: 20, itemId: 7, name: "Pasta", cancellationPending: false },
              ],
            },
          ],
    };
  if (args.name === "list_deliveries" && params.has("no-meals") && !changed) {
    for (const delivery of result.deliveries as { meals: unknown[] }[]) delivery.meals = [];
  }
  if (args.name === "list_deliveries" && params.has("dates")) {
    const first = (result.deliveries as Record<string, unknown>[])[0]!;
    result.deliveries = ["05", "06", "07", "08", "09", "12", "13", "13"].map((day, index) =>
      Object.assign({}, first, {
        deliveryId: index + 1,
        date: `2026-10-${day}`,
        service: index === 7 ? "Dinner" : "Lunch",
      }),
    );
  }
  if (args.name === "list_deliveries" && params.has("layout")) {
    for (const delivery of result.deliveries as { meals: unknown[] }[])
      delivery.meals = delivery.meals.slice(0, 1);
  }
  if (args.name === "list_deliveries" && !params.has("historical")) {
    const from = args.arguments?.from;
    const to = args.arguments?.to;
    result.deliveries = (result.deliveries as { date: string }[]).filter(
      (delivery) =>
        (typeof from !== "string" || delivery.date >= from) &&
        (typeof to !== "string" || delivery.date <= to),
    );
  }
  let statusDate = args.arguments?.deliveryId === 2 ? "2026-10-06" : "2026-10-05";
  if (params.has("historical")) statusDate = "2020-01-02";
  let group = "A3";
  if (params.has("slow-aux")) group = args.arguments?.deliveryId === 1 ? "OLD" : "NEW";
  if (args.name === "get_delivery_status")
    result = {
      status: {
        deliveryId: args.arguments?.deliveryId,
        date: statusDate,
        fulfillment: params.has("tracking") ? "ontime" : "initial",
        delayed: false,
        deliveryWindow: ["11:45", "12:15"],
        timezone: "America/Los_Angeles",
        orders: [
          {
            orderId: 100,
            venue: "Seoul Kitchen",
            fulfillment: params.has("tracking") ? "ontime" : "initial",
            etaStart: params.has("tracking") ? "2026-10-05T11:50:00-07:00" : null,
            etaEnd: params.has("tracking") ? "2026-10-05T12:10:00-07:00" : null,
            dropoffCompletedAt: null,
            trackingUrl: params.has("tracking") ? "https://track.example/meal" : null,
          },
        ],
        meals: [
          {
            pieceId: "a",
            orderId: 100,
            price: 15,
            venue: "Seoul Kitchen",
            options: ["Side: Kimchi"],
            group,
            isConfirmed: true,
          },
        ],
        billing: { reportedDueCents: 250 },
      },
    };
  if (args.name === "get_menus")
    result = args.arguments?.itemId
      ? {
          item: {
            ...item,
            menuId: args.arguments.menuId,
            description: "Chili tofu, warm rice, and crisp vegetables.",
            modifiers: [
              {
                id: 3,
                name: "Side",
                required: true,
                min: 1,
                max: 1,
                options: [{ id: 4, name: "Kimchi", price: 1 }],
              },
            ],
          },
        }
      : {
          menus: [
            { menuId: 10, name: "Seoul Kitchen", items: [item] },
            {
              menuId: 20,
              name: "Second Restaurant",
              items: [
                {
                  ...item,
                  name: "Another bowl",
                  price: 22,
                  diet: "Omnivore",
                  description: "Roast chicken and rice",
                  imageUrl: null,
                },
              ],
            },
          ],
        };
  if (args.name === "get_menus" && !args.arguments?.itemId && params.has("layout"))
    result = {
      menus: [
        {
          menuId: 10,
          name: "Seoul Kitchen",
          items: [
            item,
            { ...item, itemId: 8, name: "Bulgogi bowl", price: 18 },
            { ...item, itemId: 9, name: "Mushroom bowl", price: 16 },
          ],
        },
        {
          menuId: 20,
          name: "Garden Table",
          items: [
            { ...item, name: "Roast chicken bowl", price: 22, diet: "Omnivore" },
            { ...item, itemId: 8, name: "Citrus harvest salad", price: 14 },
          ],
        },
        {
          menuId: 30,
          name: "Seoul Kitchen",
          items: [{ ...item, name: "Kimchi fried rice", price: 13 }],
        },
      ],
    };
  if (params.has("historical")) {
    if (args.name === "list_deliveries") {
      const deliveries = result.deliveries as { date: string }[];
      result.deliveries =
        args.arguments?.from === "2020-01-02"
          ? deliveries.map((delivery) => Object.assign({}, delivery, { date: "2020-01-02" }))
          : [];
    }
    if (args.name === "get_menus" || args.name === "recommend_meals")
      return {
        isError: true,
        content: [{ type: "text", text: "Menus are not available for this historical delivery." }],
      };
  }
  if (args.name === "get_menus" && !args.arguments?.itemId && params.has("many-matches")) {
    result = {
      menus: [
        {
          menuId: 10,
          name: "Seoul Kitchen",
          items: searchItems().map(({ itemId }) => ({
            ...item,
            itemId,
            name: `Curry bowl ${itemId}`,
          })),
        },
      ],
    };
  }
  if (args.name === "search_items") result = { items: searchItems() };
  if (args.name === "recommend_meals")
    result = {
      recommendations: [
        {
          menuId: params.has("slow-aux") && args.arguments?.deliveryId === 2 ? 20 : 10,
          itemId: 7,
          rank: 1,
        },
      ],
    };
  if (args.name === "set_meal") {
    if (params.has("blocked"))
      return {
        isError: true,
        content: [{ type: "text", text: "The selected meal is blocked." }],
        structuredContent: { mode: "blocked" },
      };
    if (args.arguments?.confirmToken) {
      if (params.has("slow-confirm")) await new Promise((resolve) => setTimeout(resolve, 800));
      if (params.has("unknown"))
        return {
          isError: true,
          content: [{ type: "text", text: "Outcome unknown. Refresh before trying again." }],
          structuredContent: { mode: "outcome_unknown" },
        };
      if (params.has("rejected"))
        return {
          isError: true,
          content: [{ type: "text", text: "Forkable rejected the change: delivery frozen." }],
          structuredContent: { mode: "rejected" },
        };
      changed = true;
      result = { mode: "executed" };
    } else
      result = {
        mode: "preview",
        summary: "Replace Pasta with Spicy tofu bowl (Kimchi) — $16.00",
        confirmToken: "fixture-token",
        expiresAt: new Date(Date.now() + (params.has("expired") ? -1000 : 600000)).toISOString(),
        warnings: [{ message: "Fixture preview — no live order will be sent." }],
      };
  }
  return { content: [], structuredContent: result };
};
bridge.oncalltool = respond;
bridge.onrequestdisplaymode = async ({ mode }) => {
  displayMode = mode;
  bridge.setHostContext({ displayMode: mode, availableDisplayModes: ["inline", "fullscreen"] });
  return { mode };
};
bridge.oninitialized = async () => {
  let input: Record<string, unknown> = {};
  let result: Awaited<ReturnType<typeof respond>> = { content: [], structuredContent: {} };
  if (params.has("initial-item")) {
    input = { deliveryId: 1, menuId: 20, itemId: 7 };
    result = await respond({ name: "get_menus", arguments: input });
  }
  if (params.has("initial-list")) {
    input = { from: "2026-10-05", to: "2026-10-13" };
    result = await respond({ name: "list_deliveries", arguments: input });
  }
  if (params.has("initial-status")) {
    input = { deliveryId: 2 };
    result = await respond({ name: "get_delivery_status", arguments: input });
  }
  if (params.has("historical")) {
    input = { deliveryId: 1 };
    result = await respond({ name: "get_delivery_status", arguments: input });
  }
  if (params.has("initial-search")) {
    input = { deliveryId: 1, query: params.has("many-matches") ? "curry" : "tofu" };
    result = {
      content: [],
      structuredContent: { items: searchItems() },
    };
  }
  await bridge.sendToolInput({ arguments: input });
  if (params.has("cancelled")) {
    await bridge.sendToolCancelled({ reason: "User cancelled" });
    return;
  }
  if (params.has("no-result")) return;
  if (params.has("late-empty") || params.has("late-cancelled")) {
    setTimeout(() => {
      const send = params.has("late-cancelled")
        ? bridge.sendToolCancelled({ reason: "Original call cancelled late" })
        : bridge.sendToolResult({ content: [], structuredContent: {} });
      void send.then(() => Object.assign(window, { lateLaunchEventSent: true }));
    }, 3000);
    return;
  }
  await bridge.sendToolResult(result);
};
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
document.querySelector("button")!.addEventListener("click", () =>
  bridge.setHostContext({
    theme: "dark",
    styles: {
      variables: {
        "--color-background-primary": "#181818",
        "--color-text-primary": "#ffffff",
      } as McpUiStyles,
    },
  }),
);
if (params.has("auto-size")) {
  frame.style.height = "1600px";
  frame.addEventListener("load", () => {
    // Reproduce a host document whose minimum height follows its iframe viewport.
    frame.contentDocument!.documentElement.style.minHeight = "100vh";
    frame.contentDocument!.body.style.minHeight = "100vh";
  });
}
frame.src = "/app";
