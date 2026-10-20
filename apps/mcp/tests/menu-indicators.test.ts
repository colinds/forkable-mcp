import { expect, test } from "bun:test";
import { ingredientCategories, loadMenuIndicators } from "@/server/order/menu-indicators.ts";
import { ReauthRequiredError } from "@/server/net/errors.ts";
import type { Menu, Delivery } from "@/server/order/types.ts";
import { isMenuSoldOut } from "@forkable-mcp/shared/menu-availability.ts";

const menus: Menu[] = [{ id: 1, venue: { id: 2, capacity: 10 }, sections: [] }];
const delivery: Delivery = {
  id: 3,
  forDeliveryAt: "2026-10-22T12:00:00Z",
  afternoon: false,
  orders: [{ id: 1 }, { id: 2 }, { id: 3 }],
};
const query = async <T>(root: string): Promise<T> =>
  (root === "ingredients" ? [] : { 2: { "2026-10-22": { am: 10, pm: 9 } } }) as T;

test("ingredient categories use the server mapping, keep display order and exclude hidden tags", () => {
  expect(
    ingredientCategories(
      ["yogurt", "milk", "egg", "high_carb"],
      [
        { category: "eggs", ingredients: ["egg"] },
        { category: "dairy", ingredients: ["milk", "yogurt"] },
        { category: "high_carb", ingredients: ["high_carb"] },
      ],
    ),
  ).toEqual(["dairy", "eggs"]);
  expect(ingredientCategories(undefined, [])).toBeUndefined();
  expect(ingredientCategories(["milk"], [])).toEqual([]);
  expect(ingredientCategories(["milk"], undefined)).toBeUndefined();
});

test("capacity uses the delivery's service period and floating local date", async () => {
  expect((await loadMenuIndicators({ query }, delivery, menus)).capacity.get(1)).toBe(
    "at_capacity",
  );
  expect(
    (await loadMenuIndicators({ query }, { ...delivery, afternoon: true }, menus)).capacity.get(1),
  ).toBe("available");
  expect(
    (
      await loadMenuIndicators({ query }, { ...delivery, afternoon: undefined }, menus)
    ).capacity.has(1),
  ).toBe(false);
});

test("same-menu replacement exempts usage capacity but preserves an over-capacity order signal", () => {
  const menu = { menuId: 1, capacityStatus: "at_capacity" as const };
  expect(isMenuSoldOut(menu)).toBe(true);
  expect(isMenuSoldOut(menu, { menuId: 1 })).toBe(false);
  expect(isMenuSoldOut(menu, { menuId: 2 })).toBe(true);
  expect(isMenuSoldOut({ ...menu, capacityStatus: "over_capacity" }, { menuId: 1 })).toBe(true);
  expect(
    isMenuSoldOut(
      { ...menu, capacityStatus: "over_capacity" },
      { menuId: 1, canSwapAtCapacity: true },
    ),
  ).toBe(false);
  expect(
    isMenuSoldOut(
      { ...menu, capacityStatus: "over_capacity" },
      { menuId: 2, canSwapAtCapacity: true },
    ),
  ).toBe(true);
  expect(isMenuSoldOut(undefined)).toBe(false);
});

test("small delivery groups do not invent a usage-capacity block", async () => {
  const result = await loadMenuIndicators(
    { query },
    { ...delivery, orders: [{ id: 1 }, { id: 2 }] },
    menus,
  );
  expect(result.capacity.size).toBe(0);
});

test("order over-capacity signals and demo-club exception are respected", async () => {
  const overCapacity = {
    ...delivery,
    afternoon: true,
    orders: [{ id: 4, venue: { id: 2 }, isOverVenueCapacity: true }],
  };
  expect((await loadMenuIndicators({ query }, overCapacity, menus)).capacity.get(1)).toBe(
    "over_capacity",
  );
  expect(
    (
      await loadMenuIndicators({ query }, { ...overCapacity, club: { id: 5, isDemo: true } }, menus)
    ).capacity.get(1),
  ).toBe("available");
});

test("unreported capacity and optional read failures remain unknown", async () => {
  const unknownMenus = [{ ...menus[0]!, venue: { id: 2 } }];
  expect((await loadMenuIndicators({ query }, delivery, unknownMenus)).capacity.has(1)).toBe(false);
  const failed = async <T>(): Promise<T> => {
    throw new Error("Read unavailable");
  };
  const indicators = await loadMenuIndicators({ query: failed }, delivery, menus);
  expect(indicators.capacity.size).toBe(0);
  expect(indicators.groups).toBeUndefined();
  const reauth = async <T>(): Promise<T> => {
    throw new ReauthRequiredError("expired");
  };
  await expect(loadMenuIndicators({ query: reauth }, delivery, menus)).rejects.toBeInstanceOf(
    ReauthRequiredError,
  );
});
