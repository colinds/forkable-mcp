import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import { evaluateGuards, blockers, deliveryWindow } from "@/order/guards.ts";
import {
  formatMoney,
  formatDate,
  formatDay,
  formatDateTime,
  weekdayOf,
  parseFloating,
  isPast,
} from "@/order/format.ts";
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

  test("maxTotal: blocks over the ceiling, allows at/under, ignores unknown total", () => {
    const base = { intent: "select" as const, delivery: baseDelivery, menuId: 6290, maxTotal: 30 };
    expect(
      blockers(evaluateGuards({ ...base, total: 31 })).some((x) => x.code === "over_total_ceiling"),
    ).toBe(true);
    expect(blockers(evaluateGuards({ ...base, total: 30 })).length).toBe(0); // at ceiling is allowed
    expect(blockers(evaluateGuards({ ...base })).length).toBe(0); // unknown total never blocks
  });

  test("no maxTotal: warns when over the company limit (copayAmount), silent when within", () => {
    const del: Delivery = { ...baseDelivery, copayAmount: 20 };
    const over = evaluateGuards({ intent: "select", delivery: del, menuId: 6290, total: 25 });
    const w = over.find((x) => x.code === "over_company_limit");
    expect(w?.level).toBe("warn");
    expect((w?.data as { outOfPocket?: number } | undefined)?.outOfPocket).toBe(5);
    expect(blockers(over).length).toBe(0); // it's a warning, never a block
    const within = evaluateGuards({ intent: "select", delivery: del, menuId: 6290, total: 18 });
    expect(within.some((x) => x.code === "over_company_limit")).toBe(false);
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

// Real payloads observed from the API on 2026-08-10. Note the inconsistency the parser has to
// absorb: editingCutoffAt carries a true -07:00 offset, forDeliveryAt claims `Z` but is really a
// floating local wall-clock time (lunch is not delivered at 5:01 AM Pacific).
const FOR_DELIVERY = "2026-08-11T12:01:00.000Z";
const CUTOFF = "2026-08-10T11:45:00-07:00";

describe("weekdayOf", () => {
  test("gets the weekday right for a known week", () => {
    expect(weekdayOf("2026-08-09")).toBe("Sun");
    expect(weekdayOf("2026-08-10")).toBe("Mon");
    expect(weekdayOf("2026-08-11")).toBe("Tue");
    expect(weekdayOf("2026-08-12")).toBe("Wed");
    expect(weekdayOf("2026-08-13")).toBe("Thu");
    expect(weekdayOf("2026-08-14")).toBe("Fri");
  });

  test("is not shifted by a UTC-tagged floating timestamp", () => {
    // The bug this guards: forDeliveryAt says 12:01Z, which is the previous evening in UTC-12.
    expect(weekdayOf(FOR_DELIVERY)).toBe("Tue");
    expect(formatDay(FOR_DELIVERY)).toBe("Tue 2026-08-11");
  });

  test("returns empty for junk", () => {
    expect(weekdayOf(undefined)).toBe("");
    expect(weekdayOf("nope")).toBe("");
  });
});

describe("parseFloating", () => {
  test("honors a real UTC offset as a true instant", () => {
    expect(parseFloating(CUTOFF)?.toISOString()).toBe("2026-08-10T18:45:00.000Z");
  });

  test("treats a mislabelled `Z` as local wall-clock time", () => {
    const at = parseFloating(FOR_DELIVERY)!;
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(7); // August
    expect(at.getDate()).toBe(11);
    expect(at.getHours()).toBe(12); // 12:01 local, NOT 5:01 after a UTC shift
    expect(at.getMinutes()).toBe(1);
  });

  test("parses a date-only value as local midnight, not UTC", () => {
    const at = parseFloating("2026-08-11")!;
    expect(at.getDate()).toBe(11); // `new Date("2026-08-11")` alone lands on the 10th west of UTC
    expect(at.getHours()).toBe(0);
  });

  test("returns undefined for missing/invalid input", () => {
    expect(parseFloating(undefined)).toBeUndefined();
    expect(parseFloating("not-a-date")).toBeUndefined();
  });
});

describe("formatDateTime", () => {
  // `bun test` runs at UTC, so pin a zone to make the rendered wall-clock deterministic.
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  test("renders an offset-carrying cutoff at its true local time", () => {
    expect(formatDateTime(CUTOFF)).toBe("Mon 2026-08-10 11:45 AM");
  });

  test("renders a floating timestamp at its wall-clock time, not shifted", () => {
    expect(formatDateTime(FOR_DELIVERY)).toBe("Tue 2026-08-11 12:01 PM");
  });
});

describe("isPast", () => {
  const now = new Date("2026-08-11T01:09:00.000Z"); // Mon Aug 10, 6:09 PM PDT
  test("the Aug 11 delivery's cutoff has already passed", () => {
    expect(isPast(CUTOFF, now)).toBe(true);
  });
  test("a later cutoff has not", () => {
    expect(isPast("2026-08-11T11:45:00-07:00", now)).toBe(false);
  });
  test("undefined when there's nothing to compare", () => {
    expect(isPast(undefined, now)).toBeUndefined();
  });
});

describe("deliveryWindow", () => {
  const now = new Date("2026-08-11T01:09:00.000Z"); // Mon Aug 10, 6:09 PM PDT

  test("open before the editing cutoff", () => {
    const d: Delivery = {
      id: 1234200,
      state: "initial",
      editingCutoffAt: "2026-08-11T11:45:00-07:00",
      isReadOnly: false,
      pastLateOrderDeadline: false,
      canRequestChanges: false,
    };
    const w = deliveryWindow(d, now);
    expect(w.window).toBe("open");
    expect(w.cutoffPassed).toBe(false);
    expect(w.note).toContain("Editable until");
  });

  // The case that proves editingCutoffAt is NOT the last moment a change is possible: delivery
  // #1234199 was read-only with its cutoff 6h in the past, yet still accepting change requests.
  test("grace: past the editing cutoff but change requests still accepted", () => {
    const d: Delivery = {
      id: 1234199,
      state: "grace_period",
      editingCutoffAt: CUTOFF,
      isReadOnly: true,
      pastLateOrderDeadline: false,
      canRequestChanges: true,
    };
    const w = deliveryWindow(d, now);
    expect(w.window).toBe("grace");
    expect(w.cutoffPassed).toBe(true);
    expect(w.pastLateOrderDeadline).toBe(false);
    expect(w.note).toContain("late change request is still accepted");
  });

  test("closed once past the late-order deadline", () => {
    const d: Delivery = {
      id: 1234197,
      state: "receipt_sent",
      editingCutoffAt: "2026-08-09T11:45:00-07:00",
      isReadOnly: true,
      pastLateOrderDeadline: true,
      canRequestChanges: false,
    };
    const w = deliveryWindow(d, now);
    expect(w.window).toBe("closed");
    expect(w.pastLateOrderDeadline).toBe(true);
  });

  test("an order-level late deadline closes the window too", () => {
    const d: Delivery = {
      id: 9,
      editingCutoffAt: CUTOFF,
      isReadOnly: true,
      orders: [{ id: 1, pastLateOrderDeadline: true }],
    };
    expect(deliveryWindow(d, now).window).toBe("closed");
  });

  test("reports the cutoff verbatim, never a reformatted guess", () => {
    const d: Delivery = { id: 1, editingCutoffAt: CUTOFF };
    expect(deliveryWindow(d, now).editingCutoffAt).toBe(CUTOFF);
  });

  test("no cutoff at all still yields a usable window", () => {
    const w = deliveryWindow({ id: 1, isReadOnly: false }, now);
    expect(w.window).toBe("open");
    expect(w.editingCutoffAt).toBeNull();
  });
});

describe("formatDate", () => {
  test("keeps the calendar date the API named", () => {
    expect(formatDate(FOR_DELIVERY)).toBe("2026-08-11");
    expect(formatDate(CUTOFF)).toBe("2026-08-10");
    expect(formatDate(undefined)).toBe("");
  });
});
