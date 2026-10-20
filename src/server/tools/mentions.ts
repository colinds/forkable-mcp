import {
  createMealReference,
  formatMealReference,
  mealReferenceTitle,
  referenceUri,
  referenceDate,
} from "@forkable/shared/meal-reference.ts";
import { compactDelivery } from "../order/delivery.ts";
import { registerMentions } from "@/server/mentions.ts";
import type { Menu } from "@/server/order/types.ts";
import { type McpServer } from "@modelcontextprotocol/server";
import { formatDate, formatDay } from "@/server/order/format.ts";

import { ok } from "@/server/results.ts";
import { guard } from "@/server/tools/shared.ts";
import { inProgressIds, loadDeliveries, findDelivery, loadMenus } from "@/server/order/data.ts";
import {
  flattenItems,
  resolveOneItem,
  itemDetail,
  compactItemDetail,
  fmtItemModifiers,
} from "@/server/order/menu.ts";
import { windowName, fmtDelivery } from "@/server/order/delivery.ts";

const reference = (uri: string, title: string) => ({
  type: "resource_link" as const,
  uri,
  name: title,
  title,
  mimeType: "text/markdown",
});

export function registerMentionTools(server: McpServer): void {
  registerMentions(server, {
    search: (query) =>
      guard(async (client) => {
        const { deliveries } = await loadDeliveries(client);
        const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (value: string) =>
          terms.every((term) => value.toLowerCase().includes(term));
        const results = deliveries
          .filter((d) =>
            matches(
              `${formatDate(d.forDeliveryAt)} ${formatDay(d.forDeliveryAt)} ${referenceDate(d.forDeliveryAt)} ${referenceDate(d.forDeliveryAt, "long")} ${windowName(d)} ${d.club?.name ?? ""}`,
            ),
          )
          .map((d) => {
            const service = windowName(d) || "Delivery";
            const title = `${referenceDate(d.forDeliveryAt)} · ${service[0]!.toUpperCase()}${service.slice(1)}`;
            const needsLocation = deliveries.some(
              (other) =>
                other.id !== d.id &&
                formatDate(other.forDeliveryAt) === formatDate(d.forDeliveryAt) &&
                windowName(other) === windowName(d),
            );
            return reference(
              referenceUri({ deliveryId: d.id }),
              needsLocation && d.club?.name ? `${title} · ${d.club.name}` : title,
            );
          });
        if (terms.length) {
          const menuRequests = new Map<string, Promise<Menu[]>>();
          // Fetch only current account menus, in small batches; bound the returned reference list.
          for (let offset = 0; offset < deliveries.length && results.length < 30; offset += 3) {
            // eslint-disable-next-line no-await-in-loop -- Bound concurrent menu requests to three.
            const batch = await Promise.all(
              deliveries.slice(offset, offset + 3).map(async (delivery) => {
                const key = JSON.stringify([delivery.club?.id, delivery.availableMenuIds ?? []]);
                let request = menuRequests.get(key);
                if (!request) {
                  request = loadMenus(client, delivery);
                  menuRequests.set(key, request);
                }
                return { delivery, menus: await request };
              }),
            );
            for (const { delivery, menus } of batch)
              for (const { item, menu } of flattenItems(menus)) {
                const restaurant = menu.displayName || menu.name || `menu ${menu.id}`;
                const date = formatDate(delivery.forDeliveryAt);
                if (
                  matches(
                    `${item.name} ${item.description ?? ""} ${restaurant} ${date} ${referenceDate(delivery.forDeliveryAt)}`,
                  )
                )
                  results.push(
                    reference(
                      referenceUri({ deliveryId: delivery.id, menuId: menu.id, itemId: item.id }),
                      mealReferenceTitle({ name: item.name, restaurant, date }),
                    ),
                  );
              }
          }
        }
        return ok("Forkable references", { items: results.slice(0, 30) });
      }),
    read: (ref) =>
      guard(async (client) => {
        const { deliveries, userId } = await loadDeliveries(client);
        const delivery = findDelivery(deliveries, ref.deliveryId);
        if (!delivery)
          throw new Error(
            "This delivery is no longer in your upcoming deliveries. Refresh Forkable to find a current reference.",
          );
        if (ref.menuId == null || ref.itemId == null)
          return ok(fmtDelivery(delivery, await inProgressIds(client), userId));
        const { item, menu } = resolveOneItem(
          await loadMenus(client, delivery),
          ref.itemId,
          ref.menuId,
          ref.deliveryId,
        );
        const detail = itemDetail(item, menu);
        const meal = createMealReference({
          delivery: compactDelivery(delivery, new Set(), userId),
          detail: compactItemDetail(detail),
          restaurant: menu.displayName || menu.name || "Restaurant",
        });
        return ok([formatMealReference(meal), ...fmtItemModifiers(detail)].join("\n"));
      }),
  });
}
