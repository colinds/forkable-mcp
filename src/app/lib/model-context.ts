import { visibleMeals, restaurantGroups, type MenuFilters } from "./menu-filters.ts";
import type { App, McpUiSupportedContentBlockModalities } from "@modelcontextprotocol/ext-apps";
import type { Delivery, Detail, Menu, Recommendation, SearchMatch } from "./model.ts";
export type ModelContext = Parameters<App["updateModelContext"]>[0];
export type UpdateContext = (context: ModelContext) => Promise<unknown>;

/** Explicit allowlist: never include auth state, raw tool results, or confirmation credentials. */
export function browserContext(view: {
  delivery?: Delivery;
  detail?: Detail;
  query: string;
  searchMatches?: SearchMatch[];
  filters: MenuFilters;
  recommendations: Recommendation[];
  menus: Menu[];
  choices: Record<string, number[]>;
  source: string;
  needsRefresh: boolean;
}): ModelContext {
  const delivery = view.delivery;
  const searching = view.query.trim().length > 0;
  const results = visibleMeals(
    view.menus,
    view.recommendations,
    view.query,
    view.filters,
    view.searchMatches,
  );
  const ordered = searching
    ? results
    : restaurantGroups(view.menus, results).flatMap((group) => group.items);
  const visible = ordered.map(({ menu, item }) => ({
    menuId: menu.menuId,
    itemId: item.itemId,
    name: item.name,
    restaurant: menu.name,
    price: item.price,
  }));
  const context = {
    app: "Forkable",
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
    browseLayout: searching ? "search-results" : "restaurants",
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
    visibleMeals: visible.slice(0, 30),
    totalMatchingMeals: visible.length,
    requiresDeliveryRefresh: view.needsRefresh,
  };
  return {
    structuredContent: context,
    content: [
      {
        type: "text",
        text: `The user is browsing Forkable meal deliveries${delivery ? ` for ${delivery.date} (${delivery.service ?? "meal"}), delivery ID ${delivery.deliveryId}` : "; delivery data is not loaded"}. Food requests in this app refer to the available Forkable menu. Use get_menus, search_items or recommend_meals for this delivery as needed. Browsing is not authorization to place or change an order.\n${JSON.stringify(context)}`,
      },
    ],
  };
}

export function supportedContext(
  context: ModelContext,
  modalities: McpUiSupportedContentBlockModalities,
): ModelContext {
  return {
    ...(modalities.text
      ? { content: context.content?.filter((block) => block.type === "text") }
      : {}),
    ...(modalities.structuredContent ? { structuredContent: context.structuredContent } : {}),
  };
}
