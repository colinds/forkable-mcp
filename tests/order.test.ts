import { expect, test, describe } from "bun:test";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import { evaluateGuards, blockers } from "@/order/guards.ts";
import { formatMoney } from "@/order/format.ts";
import { type MenuItem, type MenuModifier, type Delivery } from "@/order/types.ts";

// A protein single-select (required, max 1, >1 options) + a "extras" multi-select.
const protein: MenuModifier = {
  id: 16,
  name: "Choose Protein",
  required: true,
  min: 1,
  max: 1,
  options: [
    { id: 10, name: "Chicken", price: 0 },
    { id: 11, name: "Steak", price: 300 },
    { id: 12, name: "Tofu", price: 0, ingredientTags: ["soy"] },
  ],
};
const extras: MenuModifier = {
  id: 17,
  name: "Add-ons",
  required: false,
  min: 0,
  max: 2,
  options: [
    { id: 20, name: "Avocado", price: 150 },
    { id: 21, name: "Bacon", price: 200 },
    { id: 22, name: "Egg", price: 100 },
  ],
};
// A non-required single-select (should emit the [-1] sentinel when unset).
const sauce: MenuModifier = {
  id: 18,
  name: "Sauce",
  required: false,
  max: 1,
  options: [
    { id: 30, name: "None" },
    { id: 31, name: "Hot" },
  ],
};

const item: MenuItem = {
  id: 500,
  menuId: 6290,
  name: "Bowl",
  modifierIds: [16, 17, 18],
  modifiers: [protein, extras, sauce],
};

describe("resolveItemModifiers", () => {
  const hidden: MenuModifier = {
    id: 99,
    name: "h",
    required: true,
    max: 1,
    hidden: true,
    options: [
      { id: 1, name: "x" },
      { id: 2, name: "y" },
    ],
  };

  test("orders by modifierIds and drops hidden by default", () => {
    const it: MenuItem = {
      ...item,
      modifierIds: [17, 16],
      modifiers: [protein, extras, sauce, hidden],
    };
    expect(resolveItemModifiers(it).map((m) => m.id)).toEqual([17, 16, 18]);
  });

  test("includeHidden keeps hidden modifiers so their defaults are sent", () => {
    const it: MenuItem = { ...item, modifierIds: [16, 99], modifiers: [protein, hidden] };
    const mods = resolveItemModifiers(it, { includeHidden: true });
    expect(mods.map((m) => m.id)).toEqual([16, 99]);
    // A hidden required single-select must get its default option in the hash, not be omitted.
    const r = buildSelectionsHash({ item: it, modifiers: mods, choices: [] });
    expect(r.selectionsHash["99"]).toEqual([1]);
  });
});

describe("buildSelectionsHash", () => {
  test("keys by modifier id; single→[id], multi→[ids]; [-1] sentinel for unset optional single", () => {
    const r = buildSelectionsHash({
      item,
      choices: [
        { modifier: "Choose Protein", options: ["Steak"] },
        { modifier: 17, options: [20, 22] },
      ],
    });
    expect(r.selectionsHash).toEqual({ "16": [11], "17": [20, 22], "18": [-1] });
    expect(r.violations).toEqual([]);
    expect(r.extra).toBe(300 + 150 + 100);
  });

  test("required single-select auto-defaults (app-faithful); optional single → [-1]; optional multi → []", () => {
    const r = buildSelectionsHash({ item, choices: [] });
    expect(r.selectionsHash["16"]).toEqual([10]); // required single defaults to first option (Chicken)
    expect(r.selectionsHash["17"]).toEqual([]); // optional multi, none chosen
    expect(r.selectionsHash["18"]).toEqual([-1]); // optional single → sentinel
    expect(r.violations).toEqual([]);
  });

  test("required single-select default is diet-aware (skips restricted options)", () => {
    // Reorder so the restricted option is first; a soy restriction should skip it.
    const soyFirst = {
      ...protein,
      options: [
        { id: 12, name: "Tofu", ingredientTags: ["soy"] },
        { id: 10, name: "Chicken" },
      ],
    };
    const it: MenuItem = { ...item, modifierIds: [16], modifiers: [soyFirst] };
    const r = buildSelectionsHash({ item: it, choices: [], restrictedIngredients: ["soy"] });
    expect(r.selectionsHash["16"]).toEqual([10]); // skips Tofu, picks Chicken
  });

  test("multi-select above max → violation", () => {
    const r = buildSelectionsHash({
      item,
      choices: [
        { modifier: 16, options: [10] },
        { modifier: 17, options: [20, 21, 22] },
      ],
    });
    expect(r.violations.some((v) => v.modifierId === 17 && v.code === "above_max")).toBe(true);
  });

  test("unknown option → violation", () => {
    const r = buildSelectionsHash({ item, choices: [{ modifier: 16, options: ["Lobster"] }] });
    expect(r.violations.some((v) => v.code === "unknown_option")).toBe(true);
  });

  test("round-trips an existing piece's selections byte-for-byte", () => {
    // Simulate a stored piece: steak + avocado, no sauce.
    const stored = { "16": [11], "17": [20], "18": [-1] };
    const rebuilt = buildSelectionsHash({ item, previous: stored }).selectionsHash;
    expect(rebuilt).toEqual(stored);
  });

  test("round-trips a multi with several options and an unset required-less single", () => {
    const stored = { "16": [10], "17": [20, 21], "18": [-1] };
    expect(buildSelectionsHash({ item, previous: stored }).selectionsHash).toEqual(stored);
  });
});

describe("evaluateGuards", () => {
  const baseDelivery: Delivery = { id: 1, availableMenuIds: [6290], orders: [] };

  test("blocks read-only delivery", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: { ...baseDelivery, isReadOnly: true },
      menuId: 6290,
    });
    expect(blockers(g).some((x) => x.code === "delivery_read_only")).toBe(true);
  });

  test("blocks a menu not in availableMenuIds", () => {
    const g = evaluateGuards({ intent: "select", delivery: baseDelivery, menuId: 999 });
    expect(blockers(g).some((x) => x.code === "menu_not_available")).toBe(true);
  });

  test("blocks over-capacity venue", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: baseDelivery,
      menuId: 6290,
      order: { id: 1, isOverVenueCapacity: true },
    });
    expect(blockers(g).some((x) => x.code === "over_venue_capacity")).toBe(true);
  });

  test("past deadline + no late orders → block; with late orders → warn", () => {
    const blocked = evaluateGuards({
      intent: "select",
      delivery: { ...baseDelivery, pastLateOrderDeadline: true },
      menuId: 6290,
      order: { id: 1, changeRequestAllowed: true, lateOrdersRemaining: 0 },
    });
    expect(blockers(blocked).some((x) => x.code === "no_late_orders_remaining")).toBe(true);

    const warned = evaluateGuards({
      intent: "select",
      delivery: { ...baseDelivery, pastLateOrderDeadline: true },
      menuId: 6290,
      order: { id: 1, changeRequestAllowed: true, lateOrdersRemaining: 3 },
    });
    expect(blockers(warned).length).toBe(0);
    expect(warned.some((x) => x.code === "past_late_order_deadline" && x.level === "warn")).toBe(
      true,
    );
  });

  test("selection violations become blocking guards", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: baseDelivery,
      menuId: 6290,
      violations: [{ modifierId: 16, label: "Choose Protein", code: "required", selected: 0 }],
    });
    expect(blockers(g).some((x) => x.code === "selection_invalid")).toBe(true);
  });
});

describe("formatMoney", () => {
  test("formats dollars (floats), not cents", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(22)).toBe("$22.00");
    expect(formatMoney(15.85)).toBe("$15.85");
    expect(formatMoney(18.5)).toBe("$18.50");
    expect(formatMoney(-5)).toBe("-$5.00");
    expect(formatMoney()).toBe("$0.00");
  });
});
