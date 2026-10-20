import { afterEach, expect, mock, test } from "bun:test";
import { createMealQueries, createQueryClient } from "@/app/lib/queries.ts";
import type { Delivery } from "@/shared/contracts/meals.ts";

const clients: ReturnType<typeof createQueryClient>[] = [];
function client() {
  const instance = createQueryClient();
  clients.push(instance);
  return instance;
}
afterEach(() => clients.splice(0).forEach((instance) => instance.clear()));

const item = {
  menuId: 10,
  itemId: 7,
  name: "Curry",
  price: 15,
  imageUrl: null,
  description: null,
  modifiers: [],
};
const delivery: Delivery = {
  deliveryId: 1,
  date: "2099-10-05",
  service: "Lunch",
  club: "Office",
  status: "confirmed",
  fulfillment: "initial",
  meals: [],
};

test("concurrent page loaders share one MCP request", async () => {
  const call = mock(async () => ({ content: [], structuredContent: { item } }));
  const queries = createMealQueries(call);
  const cache = client();
  const options = queries.detail({ deliveryId: 1, menuId: 10, itemId: 7 });
  const results = await Promise.all([
    cache.ensureQueryData(options),
    cache.ensureQueryData(options),
  ]);
  expect(results[0]).toEqual(item);
  expect(results[1]).toEqual(item);
  expect(call).toHaveBeenCalledTimes(1);
  expect(await cache.ensureQueryData(options)).toEqual(item);
  expect(call).toHaveBeenCalledTimes(1);
});

test("meal cache identity includes delivery, menu and item", async () => {
  const call = mock(async (_name: string, args: Record<string, unknown>) => ({
    content: [],
    structuredContent: { item: { ...item, menuId: args.menuId, itemId: args.itemId } },
  }));
  const queries = createMealQueries(call);
  const cache = client();
  await cache.ensureQueryData(queries.detail({ deliveryId: 1, menuId: 10, itemId: 7 }));
  await cache.ensureQueryData(queries.detail({ deliveryId: 1, menuId: 20, itemId: 7 }));
  await cache.ensureQueryData(queries.detail({ deliveryId: 2, menuId: 10, itemId: 7 }));
  expect(call).toHaveBeenCalledTimes(3);
});

test("MCP errors are rejected without additional Query retries", async () => {
  const call = mock(async () => ({
    isError: true,
    content: [{ type: "text" as const, text: "Session expired" }],
  }));
  const cache = client();
  await expect(cache.fetchQuery(createMealQueries(call).deliveries())).rejects.toThrow(
    "Session expired",
  );
  expect(call).toHaveBeenCalledTimes(1);
  expect(cache.getDefaultOptions().mutations).toMatchObject({
    retry: false,
    networkMode: "always",
  });
  const write = mock(async () => {
    throw new Error("Outcome unknown");
  });
  const mutation = cache.getMutationCache().build(cache, { mutationFn: write });
  await expect(mutation.execute(undefined)).rejects.toThrow("Outcome unknown");
  expect(write).toHaveBeenCalledTimes(1);
});

test("tool-result seed data populates the same cache used by page loaders", async () => {
  const menus = [{ menuId: 10, name: "Kitchen", items: [item] }];
  const call = mock(async () => ({ content: [], structuredContent: { menus } }));
  const queries = createMealQueries(call, {
    input: { deliveryId: 1 },
    result: { structuredContent: { menus } },
  });
  expect(await client().ensureQueryData(queries.menus(delivery))).toMatchObject([
    { menuId: 10, name: "Kitchen", items: [{ itemId: 7, name: "Curry" }] },
  ]);
  expect(call).not.toHaveBeenCalled();
});

test("seeded deliveries use the same chronological order as fresh reads", async () => {
  const later = { ...delivery, deliveryId: 2, date: "2099-10-06" };
  const call = mock(async () => ({ content: [], structuredContent: { deliveries: [] } }));
  const queries = createMealQueries(call, {
    input: {},
    result: { structuredContent: { deliveries: [later, delivery] } },
  });
  const listed = await client().ensureQueryData(queries.deliveries());
  expect(listed.map((entry) => entry.deliveryId)).toEqual([1, 2]);
  expect(call).not.toHaveBeenCalled();
});
