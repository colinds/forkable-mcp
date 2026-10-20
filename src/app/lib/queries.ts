import { queryOptions, QueryClient } from "@tanstack/react-query";
import {
  deliveriesSchema,
  menusSchema,
  recommendationsSchema,
  deliveryStatusSchema,
  itemDetailSchema,
  searchResultsSchema,
  type Delivery,
} from "@/shared/contracts/meals.ts";
import { data, type CallTool } from "./tools.ts";
import {
  initialData,
  initialRange,
  initialLaunch,
  isPastDelivery,
  type InitialView,
} from "./initial-view.ts";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
        networkMode: "always",
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

function sortDeliveries(deliveries: Delivery[]) {
  return deliveries.toSorted((a, b) => a.date.localeCompare(b.date) || a.deliveryId - b.deliveryId);
}

export function createMealQueries(call: CallTool, initial?: InitialView) {
  const seed = initialData(initial);
  const seededAt = Date.now();
  const range = initialRange(initial);
  const initialId = initial?.input.deliveryId ?? seed.status?.deliveryId;
  function seedForDelivery<T>(delivery: Delivery, values: T[] | undefined): T[] | undefined {
    if (isPastDelivery(delivery.date)) return [];
    if (initialId === delivery.deliveryId) return values;
    return undefined;
  }
  return {
    seed,
    launch: initialLaunch(initial),
    deliveries: () =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["deliveries", range],
        queryFn: async () =>
          sortDeliveries(data(await call("list_deliveries", range), deliveriesSchema).deliveries),
        initialData: seed.deliveries ? sortDeliveries(seed.deliveries) : undefined,
      }),
    menus: (delivery: Delivery) =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["menus", delivery.deliveryId],
        queryFn: async () =>
          isPastDelivery(delivery.date)
            ? []
            : data(await call("get_menus", { deliveryId: delivery.deliveryId }), menusSchema).menus,
        initialData: seedForDelivery(delivery, seed.menus),
      }),
    recommendations: (delivery: Delivery, limit?: number) =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["recommendations", delivery.deliveryId, limit],
        queryFn: async () =>
          isPastDelivery(delivery.date)
            ? []
            : data(
                await call("recommend_meals", {
                  deliveryId: delivery.deliveryId,
                  ...(limit != null ? { limit } : {}),
                }),
                recommendationsSchema,
              ).recommendations,
        initialData: seedForDelivery(delivery, seed.recommendations),
      }),
    status: (delivery: Delivery) =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["status", delivery.deliveryId, delivery.date],
        queryFn: async () =>
          data(
            await call("get_delivery_status", {
              deliveryId: delivery.deliveryId,
              from: delivery.date,
              to: delivery.date,
            }),
            deliveryStatusSchema,
          ).status,
        initialData: seed.status?.deliveryId === delivery.deliveryId ? seed.status : undefined,
      }),
    detail: (identity: { deliveryId: number; menuId: number; itemId: number }) =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["meal", identity.deliveryId, identity.menuId, identity.itemId],
        queryFn: async () => data(await call("get_menus", identity), itemDetailSchema).item,
        initialData:
          initialId === identity.deliveryId &&
          seed.item?.menuId === identity.menuId &&
          seed.item.itemId === identity.itemId
            ? seed.item
            : undefined,
      }),
    search: (deliveryId: number, query: string) =>
      queryOptions({
        initialDataUpdatedAt: seededAt,
        queryKey: ["search", deliveryId, query],
        queryFn: async () =>
          data(await call("search_items", { deliveryId, query }), searchResultsSchema).items,
        initialData:
          initialId === deliveryId && initial?.input.query === query ? seed.searchItems : undefined,
      }),
  };
}

export type MealQueries = ReturnType<typeof createMealQueries>;
