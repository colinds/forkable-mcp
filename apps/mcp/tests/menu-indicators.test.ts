import { expect, test } from "bun:test";
import { ingredientCategories, loadMenuIndicators } from "@/server/order/menu-indicators.ts";
import { ReauthRequiredError } from "@/server/net/errors.ts";
import type { Menu, Delivery } from "@/server/order/types.ts";

const menus: Menu[] = [{ id: 1, venue: { id: 2, capacity: 10 }, sections: [] }];
const delivery: Delivery = { id: 3, forDeliveryAt: "2026-10-22T12:00:00Z", afternoon: false };
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
});

test("capacity uses the delivery's service period and floating local date", async () => {
  expect((await loadMenuIndicators({ query }, delivery, menus)).soldOut.get(1)).toBe(true);
  expect(
    (await loadMenuIndicators({ query }, { ...delivery, afternoon: true }, menus)).soldOut.get(1),
  ).toBe(false);
  expect(
    (await loadMenuIndicators({ query }, { ...delivery, afternoon: undefined }, menus)).soldOut.has(
      1,
    ),
  ).toBe(false);
});

test("order over-capacity signals and demo-club exception are respected", async () => {
  const overCapacity = {
    ...delivery,
    afternoon: true,
    orders: [{ id: 4, venue: { id: 2 }, isOverVenueCapacity: true }],
  };
  expect((await loadMenuIndicators({ query }, overCapacity, menus)).soldOut.get(1)).toBe(true);
  expect(
    (
      await loadMenuIndicators({ query }, { ...overCapacity, club: { id: 5, isDemo: true } }, menus)
    ).soldOut.get(1),
  ).toBe(false);
});

test("unreported capacity and optional read failures remain unknown", async () => {
  const unknownMenus = [{ ...menus[0]!, venue: { id: 2 } }];
  expect((await loadMenuIndicators({ query }, delivery, unknownMenus)).soldOut.has(1)).toBe(false);
  const failed = async <T>(): Promise<T> => {
    throw new Error("Read unavailable");
  };
  const indicators = await loadMenuIndicators({ query: failed }, delivery, menus);
  expect(indicators.soldOut.size).toBe(0);
  expect(indicators.groups).toEqual([]);
  const reauth = async <T>(): Promise<T> => {
    throw new ReauthRequiredError("expired");
  };
  await expect(loadMenuIndicators({ query: reauth }, delivery, menus)).rejects.toBeInstanceOf(
    ReauthRequiredError,
  );
});
