import type { OpenAIModelContextHostState } from "@openai/mcp-extensions/app";
import { type MenuView, type MenuFilters } from "./menu-filters.ts";
import type { App, McpUiSupportedContentBlockModalities } from "@modelcontextprotocol/ext-apps";
import type { Delivery, Detail } from "@/shared/contracts/meals.ts";
export type ModelContext = Parameters<App["updateModelContext"]>[0];
export type UpdateContext = (context: ModelContext) => Promise<unknown>;

/** Explicit allowlist: never include auth state, raw tool results, or confirmation credentials. */
export function browserContext(
  view: {
    delivery?: Delivery;
    detail?: Detail;
    query: string;
    filters: MenuFilters;
    choices: Record<string, number[]>;
    source: string;
    needsRefresh: boolean;
  },
  results: MenuView,
): ModelContext {
  const delivery = view.delivery;
  const visible = results.ordered.slice(0, 30).map(({ menu, item }) => ({
    menuId: menu.menuId,
    itemId: item.itemId,
    name: item.name,
    restaurant: menu.name,
    price: item.price,
  }));
  const context = {
    app: "Forkable",
    guidance:
      "Food requests refer to the available Forkable menu. Browsing is not authorization to place or change an order.",
    view: view.detail ? "meal-details" : "menu",
    delivery: delivery
      ? {
          deliveryId: delivery.deliveryId,
          date: delivery.date,
          service: delivery.service,
          club: delivery.club,
          selectedMeals: delivery.meals.map((meal) => ({
            pieceId: meal.pieceId,
            menuId: meal.menuId,
            itemId: meal.itemId,
            name: meal.name,
          })),
        }
      : null,
    search: view.query,
    browseLayout: results.searching ? "search-results" : "restaurants",
    filters: view.filters,
    focusedMeal: view.detail
      ? {
          menuId: view.detail.menuId,
          itemId: view.detail.itemId,
          name: view.detail.name,
          description: view.detail.description,
          price: view.detail.price,
          options: view.choices,
          replacementPieceId: view.source || null,
        }
      : null,
    visibleMeals: visible,
    totalMatchingMeals: results.items.length,
    requiresDeliveryRefresh: view.needsRefresh,
  };
  return { content: [], structuredContent: context };
}

export function supportedContext(
  context: ModelContext,
  modalities: McpUiSupportedContentBlockModalities,
): ModelContext {
  if (modalities.structuredContent) {
    // Automatic view state is background context; visible content is for explicit attachments.
    return { content: [], structuredContent: context.structuredContent };
  }
  return {
    content: modalities.text
      ? [
          {
            type: "text",
            annotations: { audience: ["assistant"] },
            text: `The user is browsing Forkable meal deliveries.\n${JSON.stringify(context.structuredContent)}`,
          },
        ]
      : [],
  };
}

/** Reuse host-restored context on remount instead of attaching another copy. */
export function createContextUpdater(
  app: Pick<App, "getHostContext" | "getHostCapabilities" | "updateModelContext">,
): UpdateContext {
  let lastSent: string | undefined;
  return async (context) => {
    const modalities = app.getHostCapabilities()?.updateModelContext ?? { text: {} };
    const payload = supportedContext(context, modalities);
    const snapshot = JSON.stringify(payload);
    if (snapshot === lastSent) return;

    const restored = app.getHostContext()?.["openai/modelContext"] as
      | OpenAIModelContextHostState
      | undefined;
    const previous = restored && {
      content: restored.content ?? [],
      structuredContent: restored.structuredContent,
    };
    if (lastSent !== undefined || !previous || JSON.stringify(previous) !== snapshot)
      await app.updateModelContext(payload);
    lastSent = snapshot;
  };
}
