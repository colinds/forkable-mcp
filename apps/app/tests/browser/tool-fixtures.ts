import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ResolvedFixtureConfig } from "./fixture-config.ts";

export function createToolFixtures(config: ResolvedFixtureConfig) {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const pendingAux: (() => void)[] = [];
  const pendingDetails: ((failed: boolean) => void)[] = [];
  const pendingMenus: (() => void)[] = [];
  let menuFailed = false;
  let detailFailed = false;
  let changed = false;
  const removed = new Map<number, Set<string>>();
  const item = {
    itemId: 7,
    name: "Spicy tofu bowl",
    price: 15,
    imageUrl: "https://cdn.filestackcontent.com/test-photo",
    diet: "Vegetarian",
    description: "Tofu with mango, pineapple and chili",
  };
  function searchItems() {
    if (config.searchResults === "empty") return [];
    if (config.searchResults === "many")
      return Array.from({ length: 17 }, (_, index) => ({ menuId: 10, itemId: index + 100 }));
    return [{ menuId: 20, itemId: 7 }];
  }
  let failNextRefresh = false;
  function armRefreshFailure() {
    failNextRefresh = true;
  }
  const respond = async (
    args: Parameters<NonNullable<AppBridge["oncalltool"]>>[0],
  ): ReturnType<NonNullable<AppBridge["oncalltool"]>> => {
    calls.push({ name: args.name, arguments: args.arguments });
    if (
      args.name === "get_menus" &&
      !args.arguments?.itemId &&
      config.menuRead &&
      args.arguments?.deliveryId === config.menuRead.deliveryId
    ) {
      if (config.menuRead.response === "held")
        await new Promise<void>((resolve) => pendingMenus.push(resolve));
      if (config.menuRead.response === "error-once" && !menuFailed) {
        menuFailed = true;
        return { isError: true, content: [{ type: "text", text: "Menus unavailable." }] };
      }
    }
    if (args.name === "get_menus" && args.arguments?.itemId) {
      let failed = false;
      if (config.details === "held")
        failed = await new Promise<boolean>((resolve) => pendingDetails.push(resolve));
      if (config.details === "error-once" && !detailFailed) {
        detailFailed = true;
        failed = true;
      }
      if (failed)
        return { isError: true, content: [{ type: "text", text: "Meal options unavailable." }] };
    }
    const refreshFailure = config.refreshFailure;
    if (
      failNextRefresh &&
      ((refreshFailure === "list" && args.name === "list_deliveries") ||
        (refreshFailure === "search" && args.name === "search_items"))
    ) {
      failNextRefresh = false;
      return {
        isError: true,
        content: [{ type: "text", text: "Temporary search refresh failure" }],
      };
    }
    if (
      config.auxiliaryReads === "held" &&
      args.arguments?.deliveryId === 1 &&
      ["recommend_meals", "get_delivery_status"].includes(args.name)
    ) {
      await new Promise<void>((resolve) => pendingAux.push(resolve));
    }
    if (
      config.auxiliaryReads === "error" &&
      ["recommend_meals", "get_delivery_status"].includes(args.name)
    ) {
      return { isError: true, content: [{ type: "text", text: "Auxiliary read unavailable" }] };
    }
    if (config.readError)
      return {
        isError: true,
        content: [{ type: "text", text: "Forkable session expired. Sign in again." }],
      };
    let result: Record<string, unknown> = {};
    if (args.name === "list_deliveries")
      result = {
        deliveries:
          config.deliveryScenario === "empty"
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
                      instructions: config.currentNotes,
                    },
                    {
                      pieceId: "b",
                      menuId: 20,
                      itemId: 7,
                      name: "Pasta",
                      cancellationPending: false,
                    },
                  ],
                },
              ],
      };
    if (args.name === "list_deliveries" && config.deliveryScenario === "no-meals" && !changed) {
      for (const delivery of result.deliveries as { meals: unknown[] }[]) delivery.meals = [];
    }
    if (args.name === "list_deliveries" && config.deliveryScenario === "dates") {
      const first = (result.deliveries as Record<string, unknown>[])[0]!;
      result.deliveries = ["05", "06", "07", "08", "09", "12", "13", "13"].map((day, index) =>
        Object.assign({}, first, {
          deliveryId: index + 1,
          date: `2026-10-${day}`,
          service: index === 7 ? "Dinner" : "Lunch",
        }),
      );
    }
    if (args.name === "list_deliveries" && config.menus === "restaurants") {
      for (const delivery of result.deliveries as { meals: unknown[] }[])
        delivery.meals = delivery.meals.slice(0, 1);
    }
    if (args.name === "list_deliveries" && config.deliveryScenario !== "historical") {
      const from = args.arguments?.from;
      const to = args.arguments?.to;
      result.deliveries = (result.deliveries as { date: string }[]).filter(
        (delivery) =>
          (typeof from !== "string" || delivery.date >= from) &&
          (typeof to !== "string" || delivery.date <= to),
      );
    }
    let statusDate = args.arguments?.deliveryId === 2 ? "2026-10-06" : "2026-10-05";
    if (config.deliveryScenario === "historical") statusDate = "2020-01-02";
    let group = "A3";
    if (config.auxiliaryReads === "held") group = args.arguments?.deliveryId === 1 ? "OLD" : "NEW";
    if (args.name === "get_delivery_status")
      result = {
        status: {
          deliveryId: args.arguments?.deliveryId,
          date: statusDate,
          fulfillment: config.tracking ? "ontime" : "initial",
          delayed: false,
          deliveryWindow: ["11:45", "12:15"],
          timezone: "America/Los_Angeles",
          orders: [
            {
              orderId: 100,
              venue: "Seoul Kitchen",
              fulfillment: config.tracking ? "ontime" : "initial",
              etaStart: config.tracking ? "2026-10-05T11:50:00-07:00" : null,
              etaEnd: config.tracking ? "2026-10-05T12:10:00-07:00" : null,
              dropoffCompletedAt: null,
              trackingUrl: config.tracking ? "https://track.example/meal" : null,
            },
          ],
          meals: [
            {
              pieceId: "a",
              orderId: 100,
              price: 15,
              venue: "Seoul Kitchen",
              options: config.currentOptions ?? ["Side: Kimchi"],
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
              name: args.arguments.menuId === 20 ? "Another bowl" : item.name,
              description: "Chili tofu, warm rice, and crisp vegetables.",
              instructionsAllowed: config.notesAllowed,
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
    if (args.name === "get_menus" && !args.arguments?.itemId && config.menus === "restaurants")
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
    if (config.deliveryScenario === "historical") {
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
          content: [
            { type: "text", text: "Menus are not available for this historical delivery." },
          ],
        };
    }
    if (args.name === "get_menus" && !args.arguments?.itemId && config.searchResults === "many") {
      result = {
        menus: [
          {
            menuId: 10,
            name: "Seoul Kitchen",
            items: searchItems().map(({ itemId }) =>
              Object.assign({}, item, { itemId, name: `Curry bowl ${itemId}` }),
            ),
          },
        ],
      };
    }
    if (args.name === "search_items") result = { items: searchItems() };
    if (args.name === "recommend_meals")
      result = {
        recommendations: [
          {
            menuId: config.auxiliaryReads === "held" && args.arguments?.deliveryId === 2 ? 20 : 10,
            itemId: 7,
            rank: 1,
          },
        ],
      };
    if (args.name === "set_meal" || args.name === "remove_meal") {
      if (config.write.outcome === "blocked")
        return {
          isError: true,
          content: [{ type: "text", text: "The selected meal is blocked." }],
          structuredContent: { mode: "blocked" },
        };
      if (args.arguments?.confirmToken) {
        if (config.write.delayMs)
          await new Promise((resolve) => setTimeout(resolve, config.write.delayMs));
        if (config.write.outcome === "unknown")
          return {
            isError: true,
            content: [{ type: "text", text: "Outcome unknown. Refresh before trying again." }],
            structuredContent: { mode: "outcome_unknown" },
          };
        if (config.write.outcome === "rejected")
          return {
            isError: true,
            content: [{ type: "text", text: "Forkable rejected the change: delivery frozen." }],
            structuredContent: { mode: "rejected" },
          };
        if (args.name === "set_meal") changed = true;
        else {
          const id = Number(args.arguments?.deliveryId);
          const pieces = removed.get(id) ?? new Set<string>();
          pieces.add(String(args.arguments?.pieceId));
          removed.set(id, pieces);
        }
        result = { mode: "executed" };
      } else
        result = {
          mode: "preview",
          summary:
            args.name === "remove_meal"
              ? "Remove Pasta from delivery 1"
              : "Replace Pasta with Spicy tofu bowl (Kimchi) — $16.00",
          confirmToken: "fixture-token",
          expiresAt: new Date(
            Date.now() + (config.write.outcome === "expired" ? -1000 : 600000),
          ).toISOString(),
          warnings: [{ message: "Fixture preview — no live order will be sent." }],
        };
    }
    if (args.name === "list_deliveries") {
      for (const delivery of result.deliveries as {
        deliveryId: number;
        meals: { pieceId: string }[];
      }[]) {
        delivery.meals = delivery.meals.filter(
          (meal) => !removed.get(delivery.deliveryId)?.has(String(meal.pieceId)),
        );
      }
    }
    return { content: [], structuredContent: result };
  };
  return {
    respond,
    calls,
    armRefreshFailure,
    changeMeal: () => {
      changed = true;
    },
    releaseDetail: (index: number, failed = false) => pendingDetails[index]?.(failed),
    releaseMenus: () => pendingMenus.splice(0).forEach((release) => release()),
    releaseAux: () => pendingAux.splice(0).forEach((release) => release()),
  };
}
