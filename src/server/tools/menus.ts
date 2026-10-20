import {
  getMenusResultSchema,
  searchResultsSchema,
  recommendationsSchema,
} from "@/shared/contracts/meals.ts";
import {
  getMenusInputSchema,
  searchItemsInputSchema,
  recommendMealsInputSchema,
} from "@/shared/contracts/inputs.ts";
import { type McpServer } from "@modelcontextprotocol/server";

import { appResult, errResult } from "@/server/results.ts";
import { appGuard, APP_TOOL_META } from "@/server/tools/shared.ts";
import { loadDeliveries, findDelivery, loadMenus, loadDietLabels } from "@/server/order/data.ts";
import {
  imageMd,
  flattenItems,
  findItem,
  resolveOneItem,
  formatKnownPrice,
  compactMenus,
  compactItemDetail,
  itemDetail,
  fmtItemDetail,
} from "@/server/order/menu.ts";

export function registerMenuTool(server: McpServer): void {
  server.registerTool(
    "get_menus",
    {
      _meta: APP_TOOL_META,
      title: "Get menus for a delivery",
      description:
        "List menu items for a delivery. Item IDs can repeat across menus; pass both menuId and itemId " +
        "to get the modifier and option IDs for one item.",
      inputSchema: getMenusInputSchema,
      outputSchema: getMenusResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, itemId, menuId }) =>
      appGuard(async (client) => {
        const { deliveries } = await loadDeliveries(client);
        const d = findDelivery(deliveries, deliveryId);
        if (!d) return errResult(`Delivery ${deliveryId} not found in your upcoming deliveries.`);
        const menus = await loadMenus(client, d);
        if (!menus.length)
          return appResult(getMenusResultSchema, `Delivery ${deliveryId} has no available menus.`, {
            menus: [],
          });
        // Detail mode includes the modifier and option ids needed for set_meal.
        if (itemId != null) {
          const { item, menu } = resolveOneItem(menus, itemId, menuId, deliveryId);
          const detail = itemDetail(item, menu);
          return appResult(getMenusResultSchema, fmtItemDetail(detail) + imageMd(item), {
            item: compactItemDetail(detail),
          });
        }

        const summary = menus
          .map((m) => {
            const items = m.sections.flatMap((s) => s.items);
            const lines = items.map(
              (it) => `    ${it.id}  ${it.name}  ${formatKnownPrice(it.price)}${imageMd(it)}`,
            );
            return `${m.displayName || m.name || `menu ${m.id}`} (${items.length} items):\n${lines.join("\n")}`;
          })
          .join("\n\n");
        return appResult(getMenusResultSchema, summary || "No items.", {
          menus: compactMenus(menus, await loadDietLabels(client)),
        });
      }),
  );
}

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "search_items",
    {
      _meta: APP_TOOL_META,
      title: "Search menu items",
      description:
        "Search items across a delivery's available menus by keyword. Returns meal data without opening a UI. To display results, call open_forkable afterwards with this deliveryId and query.",
      inputSchema: searchItemsInputSchema,
      outputSchema: searchResultsSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, query }) =>
      appGuard(async (client) => {
        const d = findDelivery((await loadDeliveries(client)).deliveries, deliveryId);
        if (!d?.availableMenuIds?.length)
          return errResult(`Delivery ${deliveryId} not found or has no menus.`);
        const res = await client.query<{ nodes: { id: number; menuId: number }[] }>(
          "searchMenuItems",
          { menuIds: d.availableMenuIds, search: query },
          "nodes { id menuId }",
        );
        const nodes = res?.nodes ?? [];
        if (!nodes.length)
          return appResult(searchResultsSchema, `No items match "${query}".`, { items: [] });
        const items = flattenItems(await loadMenus(client, d));
        const results = nodes.map((n) => {
          const it = findItem(items, n.menuId, n.id)?.item;
          return {
            itemId: n.id,
            menuId: n.menuId,
            name: it?.name ?? null,
            price: it?.price ?? null,
            imageUrl: it?.imageUrl ?? null,
          };
        });
        const lines = results.map(
          (r) =>
            `  ${r.itemId}  ${r.name ?? "(item)"}  ${formatKnownPrice(r.price)}  [menu ${r.menuId}]${imageMd({ name: r.name ?? "item", imageUrl: r.imageUrl })}`,
        );
        return appResult(searchResultsSchema, `Matches for "${query}":\n${lines.join("\n")}`, {
          items: results,
        });
      }),
  );
}

export function registerRecommendationTool(server: McpServer): void {
  server.registerTool(
    "recommend_meals",
    {
      _meta: APP_TOOL_META,
      title: "Recommend meals",
      description: "Return Forkable's ranked meal suggestions for a delivery.",
      inputSchema: recommendMealsInputSchema,
      outputSchema: recommendationsSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, limit }) =>
      appGuard(async (client) => {
        const { deliveries, userId } = await loadDeliveries(client);
        const d = findDelivery(deliveries, deliveryId);
        if (!d?.availableMenuIds?.length)
          return errResult(`Delivery ${deliveryId} not found or has no menus.`);
        const scores =
          (await client.query<{ menuId: number; itemId: number; score: number }[]>(
            "mealGenerationScores",
            { deliveryId, menuIds: d.availableMenuIds, userId },
            "menuId itemId score",
          )) ?? [];
        const top = scores.toSorted((a, b) => b.score - a.score).slice(0, limit ?? 8);
        if (!top.length)
          return appResult(recommendationsSchema, "No recommendations available.", {
            recommendations: [],
          });
        const items = flattenItems(await loadMenus(client, d));
        const enriched = top.map((t, index) => {
          const it = findItem(items, t.menuId, t.itemId)?.item;
          return {
            menuId: t.menuId,
            itemId: t.itemId,
            rank: index + 1,
            name: it?.name ?? `item ${t.itemId}`,
            price: it?.price ?? null,
            imageUrl: it?.imageUrl ?? null,
          };
        });
        const lines = enriched.map(
          (e, i) => `  ${i + 1}. ${e.name}  ${formatKnownPrice(e.price)}${imageMd(e)}`,
        );
        return appResult(
          recommendationsSchema,
          `Top picks for delivery ${deliveryId}:\n${lines.join("\n")}`,
          {
            recommendations: enriched,
          },
        );
      }),
  );
}
