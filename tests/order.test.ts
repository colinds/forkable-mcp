import { expect, test, describe } from "bun:test";
import { buildSelectionsHash, resolveItemModifiers } from "@/order/selections.ts";
import {
  evaluateGuards,
  blockers,
  deliveryWindow,
  findOwnMeal,
  allPieces,
  orderForGuards,
  ownPieces,
} from "@/order/guards.ts";
import { deliveryStatus, formatDeliveryStatus } from "@/order/status.ts";
import {
  formatMoney,
  formatDate,
  formatDay,
  formatDateTime,
  weekdayOf,
  parseFloating,
  isPast,
  formatInstantLike,
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
    { id: 11, name: "Steak", price: 3 },
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
    { id: 20, name: "Avocado", price: 1.5 },
    { id: 21, name: "Bacon", price: 2 },
    { id: 22, name: "Egg", price: 1 },
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
    expect(r.extra).toBe(3 + 1.5 + 1); // dollars, not cents
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
  // Rendered in the offset Forkable sent, like the dashboard. No Date involved, so no host-zone
  // dependence and nothing to pin — `bun test` runs at UTC and these hold anyway.
  test("shows the cutoff as the dashboard does", () => {
    expect(formatDateTime(CUTOFF)).toBe("Mon 2026-08-10 11:45 AM");
  });

  test("shows a floating timestamp's wall clock as written", () => {
    expect(formatDateTime(FOR_DELIVERY)).toBe("Tue 2026-08-11 12:01 PM");
  });

  test("handles midnight and noon without a 0:xx or 12 AM/PM mixup", () => {
    expect(formatDateTime("2026-08-10T00:30:00-07:00")).toBe("Mon 2026-08-10 12:30 AM");
    expect(formatDateTime("2026-08-10T12:00:00-07:00")).toBe("Mon 2026-08-10 12:00 PM");
  });

  test("falls back to the date when there's no time part", () => {
    expect(formatDateTime("2026-08-10")).toBe("Mon 2026-08-10");
    expect(formatDateTime(undefined)).toBe("");
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
  test("open while not read-only and not past the late deadline", () => {
    const d: Delivery = {
      id: 1234200,
      state: "initial",
      isReadOnly: false,
      pastLateOrderDeadline: false,
      canRequestChanges: false,
    };
    const w = deliveryWindow(d);
    expect(w.window).toBe("open");
    expect(w.note).toContain("Editable");
  });

  test("grace: read-only but a late change request still lands", () => {
    const d: Delivery = {
      id: 1234199,
      state: "grace_period",
      isReadOnly: true,
      pastLateOrderDeadline: false,
      canRequestChanges: true,
    };
    const w = deliveryWindow(d);
    expect(w.window).toBe("grace");
    expect(w.pastLateOrderDeadline).toBe(false);
    expect(w.note).toContain("late order or change request is still accepted");
  });

  test("closed once past the late-order deadline", () => {
    const d: Delivery = {
      id: 1234197,
      state: "receipt_sent",
      isReadOnly: true,
      pastLateOrderDeadline: true,
      canRequestChanges: false,
    };
    const w = deliveryWindow(d);
    expect(w.window).toBe("closed");
    expect(w.pastLateOrderDeadline).toBe(true);
  });

  test("an order-level late deadline closes the window too", () => {
    const d: Delivery = {
      id: 9,
      isReadOnly: true,
      orders: [{ id: 1, pastLateOrderDeadline: true }],
    };
    expect(deliveryWindow(d).window).toBe("closed");
  });

  test("no timestamp is consulted or reported — the window is booleans only", () => {
    const w = deliveryWindow({ id: 1, isReadOnly: false });
    expect(w.window).toBe("open");
    expect(Object.keys(w).toSorted()).toEqual(["note", "pastLateOrderDeadline", "window"]);
    // The policy lives in the note; the API exposes no member-facing deadline field.
    expect(w.note).toContain("2pm the day before");
  });
});

describe("formatDate", () => {
  test("keeps the calendar date the API named", () => {
    expect(formatDate(FOR_DELIVERY)).toBe("2026-08-11");
    expect(formatDate(CUTOFF)).toBe("2026-08-10");
    expect(formatDate(undefined)).toBe("");
  });
});

// --- Multi-order deliveries ------------------------------------------------------------------
// A delivery carries one order PER VENUE and your pieces sit on exactly one of them, at an index
// that moves day to day. These fixtures are transcribed from the real Aug 11 / Aug 13 payloads.

const myPiece = {
  id: "p1",
  itemId: 9,
  menuId: 3,
  name: "Shan Noodle",
  price: 18.99,
  autoOrder: true,
};

/** 4 venue orders, the user's meal on the LAST one — the shape that breaks `orders[0]`. */
const fourOrders: Delivery = {
  id: 1234199,
  availableMenuIds: [1, 2, 3, 4],
  orders: [
    { id: 1, menu: { id: 1, name: "United Dumplings" }, lateOrdersRemaining: 0 },
    { id: 2, menu: { id: 2, name: "Taqueria Los Altos" }, lateOrdersRemaining: 6 },
    { id: 3, menu: { id: 3, name: "Kitava" }, lateOrdersRemaining: 6 },
    { id: 4, menu: { id: 4, name: "Burma Classic" }, lateOrdersRemaining: 6, pieces: [myPiece] },
  ],
};

describe("findOwnMeal / allPieces", () => {
  test("finds the order holding your pieces, not orders[0]", () => {
    const own = findOwnMeal(fourOrders);
    expect(own?.order.id).toBe(4);
    expect(own?.pieces.length).toBe(1);
    expect(own?.ambiguous).toBe(false);
  });

  test("undefined when no order carries pieces", () => {
    expect(findOwnMeal({ id: 1, orders: [{ id: 1 }, { id: 2 }] })).toBeUndefined();
    expect(findOwnMeal({ id: 1 })).toBeUndefined();
  });

  test("several orders with pieces → first, flagged ambiguous", () => {
    const d: Delivery = {
      id: 1,
      orders: [
        { id: 1, pieces: [myPiece] },
        { id: 2, pieces: [myPiece] },
      ],
    };
    expect(findOwnMeal(d)?.order.id).toBe(1);
    expect(findOwnMeal(d)?.ambiguous).toBe(true);
  });

  test("allPieces flattens every venue order (guest picks included)", () => {
    const d: Delivery = {
      id: 1,
      orders: [{ id: 1, pieces: [myPiece] }, { id: 2 }, { id: 3, pieces: [myPiece, myPiece] }],
    };
    expect(allPieces(d).length).toBe(3);
    expect(allPieces({ id: 1, orders: [] })).toEqual([]);
  });
});

describe("orderForGuards", () => {
  test("a cross-venue switch keys off the venue you're JOINING, not your current one", () => {
    // Your meal is on order 4 (menu 4); you're switching to menu 1. Capacity and the late-order
    // budget belong to menu 1's venue, so that order is the one guards must read.
    expect(orderForGuards(fourOrders, 1)?.id).toBe(1);
  });

  test("no menuId (remove/skip/confirm) → your own order", () => {
    expect(orderForGuards(fourOrders)?.id).toBe(4);
  });

  test("re-ordering the same venue resolves to your own order either way", () => {
    expect(orderForGuards(fourOrders, 4)?.id).toBe(4);
  });

  test("nothing selected → the venue you're ordering FROM", () => {
    const empty: Delivery = {
      id: 1,
      orders: [
        { id: 1, menu: { id: 10 } },
        { id: 2, menu: { id: 20 } },
      ],
    };
    expect(orderForGuards(empty, 20)?.id).toBe(2);
  });

  test("multi-order with no match → undefined, NOT an arbitrary venue", () => {
    const empty: Delivery = {
      id: 1,
      orders: [
        { id: 1, menu: { id: 10 } },
        { id: 2, menu: { id: 20 } },
      ],
    };
    expect(orderForGuards(empty, 999)).toBeUndefined();
    expect(orderForGuards(empty)).toBeUndefined();
  });

  test("a single-order club falls back to that order", () => {
    expect(orderForGuards({ id: 1, orders: [{ id: 7, menu: { id: 10 } }] })?.id).toBe(7);
  });
});

describe("evaluateGuards on a multi-order delivery", () => {
  // The regression: reading orders[0] looked clean while the target venue was over capacity.
  test("capacity is read off the venue you're JOINING, not orders[0]", () => {
    const d: Delivery = {
      ...fourOrders,
      availableMenuIds: [1, 4],
      orders: [
        { id: 1, menu: { id: 1 }, isOverVenueCapacity: false, pieces: [myPiece] },
        { id: 4, menu: { id: 4 }, isOverVenueCapacity: true },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 4),
      menuId: 4,
    });
    expect(blockers(g).some((x) => x.code === "over_venue_capacity")).toBe(true);

    // ...and the clean venue does NOT inherit the other one's capacity problem.
    const clean = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    expect(blockers(clean).some((x) => x.code === "over_venue_capacity")).toBe(false);
  });

  test("capacity never blocks the venue you already hold — re-customizing isn't a new seat", () => {
    const ME = 501;
    const d: Delivery = {
      ...fourOrders,
      availableMenuIds: [4],
      orders: [
        { id: 4, menu: { id: 4 }, isOverVenueCapacity: true, pieces: [{ ...myPiece, userId: ME }] },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 4),
      menuId: 4,
      user: { id: ME },
    });
    expect(blockers(g).some((x) => x.code === "over_venue_capacity")).toBe(false);
  });

  test("a GUEST's meal at that venue does not make it 'yours' — capacity still blocks", () => {
    const d: Delivery = {
      ...fourOrders,
      availableMenuIds: [4],
      orders: [
        // No userId on the piece, so identity matching can't succeed; the fallback must not be
        // mistaken for "you are already at this venue".
        { id: 4, menu: { id: 4 }, isOverVenueCapacity: true, pieces: [myPiece] },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 4),
      menuId: 4,
      user: { id: 501 },
    });
    expect(blockers(g).some((x) => x.code === "over_venue_capacity")).toBe(true);
  });

  test("late-order budget comes from your order, so a stale orders[0] can't block", () => {
    const d: Delivery = { ...fourOrders, pastLateOrderDeadline: true };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 3),
      menuId: 3,
    });
    expect(blockers(g).some((x) => x.code === "no_late_orders_remaining")).toBe(false);
    expect(g.some((x) => x.code === "past_late_order_deadline" && x.level === "warn")).toBe(true);
  });

  test("pieces on two orders raises a warn, never a block", () => {
    const d: Delivery = {
      id: 1,
      availableMenuIds: [1],
      orders: [
        { id: 1, pieces: [myPiece] },
        { id: 2, pieces: [myPiece] },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d),
      menuId: 1,
    });
    const w = g.find((x) => x.code === "multiple_own_orders");
    expect(w?.level).toBe("warn");
    expect(blockers(g).some((x) => x.code === "multiple_own_orders")).toBe(false);
  });
});

// --- Honest-UTC display ----------------------------------------------------------------------
// dropoffCompletedAt's `Z` is real, unlike forDeliveryAt's. Verified from the live payload:
// 18:41:44Z lines up exactly with etaStatus.end 11:50:00-07:00.
const ETA_START = "2026-08-11T11:35:00-07:00";

describe("formatInstantLike", () => {
  test("renders an honest-UTC instant in the sibling's offset", () => {
    expect(formatInstantLike("2026-08-11T18:41:44.000Z", ETA_START, "PT")).toBe(
      "Tue 2026-08-11 11:41 AM PT",
    );
    expect(formatInstantLike("2026-08-11T18:41:44.000Z", ETA_START)).toBe(
      "Tue 2026-08-11 11:41 AM",
    );
  });

  test("crosses midnight in both directions", () => {
    expect(formatInstantLike("2026-08-11T02:00:00.000Z", ETA_START)).toBe("Mon 2026-08-10 7:00 PM");
    expect(formatInstantLike("2026-08-11T20:00:00.000Z", "2026-08-11T00:00:00+05:30")).toBe(
      "Wed 2026-08-12 1:30 AM",
    );
  });

  test("accepts a compact offset", () => {
    expect(formatInstantLike("2026-08-11T18:41:44.000Z", "2026-08-11T11:35:00-0700")).toBe(
      "Tue 2026-08-11 11:41 AM",
    );
  });

  test('"" rather than a wrong clock when anything is missing', () => {
    expect(formatInstantLike(undefined, ETA_START)).toBe("");
    expect(formatInstantLike("2026-08-11T18:41:44.000Z", undefined)).toBe("");
    // A lying `Z` carries no offset, so it can't be a zone source.
    expect(formatInstantLike("2026-08-11T18:41:44.000Z", "2026-08-11T12:01:00.000Z")).toBe("");
    // A floating value is refused outright — shifting it would move the wall clock.
    expect(formatInstantLike("2026-08-11T11:41:44", ETA_START)).toBe("");
  });
});

// --- Delivery status view --------------------------------------------------------------------

const DELIVERED: Delivery = {
  id: 1234199,
  state: "grace_period",
  simpleState: "delivered",
  forDeliveryAt: FOR_DELIVERY,
  isReadOnly: true,
  pastLateOrderDeadline: true,
  deliveryWindow: ["11:45", "12:15"],
  serviceWindow: { baseTime: "12:00:00", name: "lunch" },
  reportMissingItemCutoff: "2026-08-11T20:00:00.000Z",
  address: { formatted: "350 Rhode Island St, San Francisco, CA", notes: "Gate code #1234" },
  copayAmount: 20,
  orders: [
    { id: 1, menu: { id: 1, name: "United Dumplings" } },
    {
      id: 4,
      menu: { id: 4, name: "Burma Classic" },
      venue: { id: 3, displayName: "Burma Classic" },
      dropoffCompletedAt: "2026-08-11T18:41:44.000Z",
      etaStatus: {
        start: ETA_START,
        end: "2026-08-11T11:50:00-07:00",
        shortTz: "PT",
        status: "delivered",
        trackingUrl: "https://onf.lt/cfa6b0a0c0",
      },
      pieces: [myPiece],
    },
  ],
};

describe("deliveryStatus", () => {
  test("reads fulfillment and the courier trail off YOUR order", () => {
    const s = deliveryStatus(DELIVERED);
    expect(s.fulfillment).toBe("delivered");
    expect(s.arrivedAt).toBe("Tue 2026-08-11 11:41 AM PT");
    expect(s.etaWindow).toBe("11:35–11:50 AM PT");
    expect(s.arrivalWindow).toBe("11:45–12:15");
    expect(s.service).toBe("lunch, base 12:00");
    expect(s.trackingUrl).toBe("https://onf.lt/cfa6b0a0c0");
    expect(s.meal[0]?.venue).toBe("Burma Classic");
    expect(s.meal[0]?.autoOrder).toBe(true);
  });

  test("a pre-dispatch day degrades to nulls, not throws", () => {
    const s = deliveryStatus({
      id: 7,
      forDeliveryAt: FOR_DELIVERY,
      deliveryWindow: ["11:45", "12:15"],
      orders: [],
    });
    expect(s.fulfillment).toBe("not yet dispatched");
    expect(s.arrivedAt).toBeNull();
    expect(s.etaWindow).toBeNull();
    expect(s.arrivalWindow).toBe("11:45–12:15");
    expect(s.meal).toEqual([]);
  });

  test("the club's IANA zone drives the arrival clock", () => {
    const d: Delivery = {
      id: 8,
      forDeliveryAt: FOR_DELIVERY,
      club: { id: 1, market: { timezone: "America/Los_Angeles" } },
      orders: [{ id: 1, dropoffCompletedAt: "2026-08-11T18:41:44.000Z", pieces: [myPiece] }],
    };
    // No shortTz to label it with, so the clock comes through unsuffixed.
    expect(deliveryStatus(d).arrivedAt).toBe("Tue 2026-08-11 11:41 AM");
  });

  test("with no zone and no etaStatus it renders nothing rather than guessing", () => {
    const d: Delivery = {
      id: 8,
      forDeliveryAt: FOR_DELIVERY,
      orders: [{ id: 1, dropoffCompletedAt: "2026-08-11T18:41:44.000Z", pieces: [myPiece] }],
    };
    expect(deliveryStatus(d).arrivedAt).toBeNull();
    expect(deliveryStatus(d).arrivedAtRaw).toBe("2026-08-11T18:41:44.000Z");
  });
});

describe("formatDeliveryStatus", () => {
  test("renders the delivered shape", () => {
    const out = formatDeliveryStatus(deliveryStatus(DELIVERED));
    expect(out).toContain("Delivery 1234199 — Tue 2026-08-11 — delivered");
    expect(out).toContain("Shan Noodle $18.99 — Burma Classic");
    expect(out).toContain("Arrived    : Tue 2026-08-11 11:41 AM PT");
    expect(out).toContain("Tracking   : https://onf.lt/cfa6b0a0c0");
    expect(out).toContain("Gate code #1234");
  });

  test("the missing-item deadline renders as a clock in the delivery's zone", () => {
    const s = deliveryStatus(DELIVERED);
    // Honest UTC: 20:00Z is 1 PM Pacific, matching how the product itself displays it.
    expect(s.reportMissingItemCutoff).toBe("Tue 2026-08-11 1:00 PM PT");
    expect(formatDeliveryStatus(s)).toContain("Report by  : Tue 2026-08-11 1:00 PM PT");
    // The raw value stays available for a caller that wants to resolve the zone itself.
    expect(s.reportMissingItemCutoffRaw).toBe("2026-08-11T20:00:00.000Z");
    expect(formatDeliveryStatus(s)).not.toContain("20:00");
  });

  test("optional lines are omitted, not blanked", () => {
    const out = formatDeliveryStatus(
      deliveryStatus({ id: 7, forDeliveryAt: FOR_DELIVERY, orders: [] }),
    );
    expect(out).not.toContain("Tracking");
    expect(out).not.toContain("Arrived");
    expect(out).not.toContain("Access");
    expect(out).toContain("— nothing selected");
  });
});

// --- Cross-venue writes touch TWO orders -------------------------------------------------------

describe("cross-venue select gates both orders", () => {
  // replacePiece removes from the source venue's order and adds to the target's, so a refusal on
  // EITHER has to block. Reading only the target lost this.
  const sourceRefuses: Delivery = {
    id: 9,
    availableMenuIds: [1, 4],
    pastLateOrderDeadline: false,
    orders: [
      { id: 1, menu: { id: 1 }, changeRequestAllowed: true, lateOrdersRemaining: 6 },
      {
        id: 4,
        menu: { id: 4 },
        changeRequestAllowed: false,
        lateOrdersRemaining: 0,
        pastLateOrderDeadline: true,
        pieces: [myPiece],
      },
    ],
  };

  test("a source order that refuses changes blocks the move", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: sourceRefuses,
      order: orderForGuards(sourceRefuses, 1), // target: order 1, clean
      sourceOrder: findOwnMeal(sourceRefuses)?.order, // source: order 4, refuses
      menuId: 1,
    });
    expect(blockers(g).some((x) => x.code === "change_request_not_allowed")).toBe(true);
  });

  test("the deadline rolls up across all orders, so it survives an unresolved target", () => {
    // Nothing selected and no order sells menu 3, so no order resolves at all. The deadline lives on
    // a sibling order; before the rollup it was read off the resolved order only and vanished here.
    const nothingSelected: Delivery = {
      id: 9,
      availableMenuIds: [1, 3],
      orders: [
        { id: 1, menu: { id: 1 } },
        { id: 2, menu: { id: 2 }, pastLateOrderDeadline: true },
      ],
    };
    expect(orderForGuards(nothingSelected, 3)).toBeUndefined();
    const g = evaluateGuards({
      intent: "select",
      delivery: nothingSelected,
      order: orderForGuards(nothingSelected, 3),
      menuId: 1,
    });
    expect(g.some((x) => x.code === "past_late_order_deadline")).toBe(true);
  });

  test("both orders clean → no blockers", () => {
    const clean: Delivery = {
      id: 9,
      availableMenuIds: [1, 4],
      orders: [
        { id: 1, menu: { id: 1 }, changeRequestAllowed: true },
        { id: 4, menu: { id: 4 }, changeRequestAllowed: true, pieces: [myPiece] },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: clean,
      order: orderForGuards(clean, 1),
      sourceOrder: findOwnMeal(clean)?.order,
      menuId: 1,
    });
    expect(blockers(g).length).toBe(0);
  });
});

describe("findOwnMeal with a guest order", () => {
  const ME = 501;
  const guestFirst: Delivery = {
    id: 9,
    orders: [
      {
        id: 1,
        menu: { id: 1 },
        pieces: [{ ...myPiece, id: "guest-1", userId: 999, name: "Guest burrito" }],
      },
      { id: 2, menu: { id: 2 }, pieces: [{ ...myPiece, id: "mine-1", userId: ME }] },
    ],
  };

  test("without a userId it picks the wrong piece — a guest's — and says so", () => {
    const own = findOwnMeal(guestFirst);
    expect(own?.pieces[0]?.id).toBe("guest-1");
    expect(own?.ambiguous).toBe(true);
  });

  test("with a userId it resolves the right piece and is unambiguous", () => {
    const own = findOwnMeal(guestFirst, ME);
    expect(own?.pieces[0]?.id).toBe("mine-1");
    expect(own?.order.id).toBe(2);
    expect(own?.ambiguous).toBe(false);
  });

  test("order position cannot change the answer once userId is supplied", () => {
    const reversed: Delivery = { ...guestFirst, orders: (guestFirst.orders ?? []).toReversed() };
    expect(findOwnMeal(reversed, ME)?.pieces[0]?.id).toBe("mine-1");
  });

  test("falls back to first-with-pieces when no piece carries a userId", () => {
    expect(findOwnMeal(fourOrders, ME)?.order.id).toBe(4);
  });
});

describe("replacement-driven gates", () => {
  const myPieceOn = (menuId: number) => ({ ...myPiece, menuId });

  test("a venue-replacement re-opens a read-only delivery", () => {
    const d: Delivery = {
      id: 9,
      isReadOnly: true,
      availableMenuIds: [1],
      orders: [{ id: 1, menu: { id: 1 }, replaces: { id: 99, menu: { id: 1 } } }],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    expect(blockers(g).some((x) => x.code === "delivery_read_only")).toBe(false);
  });

  test("...and bypasses an exhausted late-order budget", () => {
    const d: Delivery = {
      id: 9,
      pastLateOrderDeadline: true,
      availableMenuIds: [1],
      orders: [
        { id: 1, menu: { id: 1 }, lateOrdersRemaining: 0, replaces: { id: 99, menu: { id: 1 } } },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    expect(blockers(g).some((x) => x.code === "no_late_orders_remaining")).toBe(false);
  });

  test("a sibling order's pending replacement warns that the day may be frozen", () => {
    const d: Delivery = {
      id: 9,
      availableMenuIds: [1, 2],
      orders: [
        { id: 1, menu: { id: 1 }, pieces: [myPieceOn(1)] },
        { id: 2, menu: { id: 2 }, replaces: { id: 99, menu: { id: 2 } } },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    const w = g.find((x) => x.code === "sibling_replacement_pending");
    expect(w?.level).toBe("warn"); // warn, not block — modelled but not yet observed live
    expect(blockers(g).some((x) => x.code === "sibling_replacement_pending")).toBe(false);
  });

  test("a late_replacement piece anywhere on the delivery warns too", () => {
    const d: Delivery = {
      id: 9,
      availableMenuIds: [1],
      orders: [
        { id: 1, menu: { id: 1 }, pieces: [myPieceOn(1)] },
        { id: 2, menu: { id: 2 }, pieces: [{ ...myPiece, flowType: "late_replacement" }] },
      ],
    };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    expect(g.some((x) => x.code === "sibling_replacement_pending")).toBe(true);
  });
});

describe("removal gates", () => {
  test("an `initial` delivery still accepts a removal past the late deadline", () => {
    const d: Delivery = {
      id: 9,
      state: "initial",
      pastLateOrderDeadline: true,
      orders: [{ id: 1, lateRemovalsRemaining: 0, pieces: [myPiece] }],
    };
    const g = evaluateGuards({ intent: "remove", delivery: d, order: orderForGuards(d) });
    expect(blockers(g).some((x) => x.code === "no_late_removals_remaining")).toBe(false);
  });

  test("a club with late removal disabled blocks past the deadline", () => {
    const d: Delivery = {
      id: 9,
      state: "grace_period",
      pastLateOrderDeadline: true,
      club: { id: 1, isLateRemovalEnabled: false },
      orders: [{ id: 1, lateRemovalsRemaining: 6, pieces: [myPiece] }],
    };
    const g = evaluateGuards({ intent: "remove", delivery: d, order: orderForGuards(d) });
    expect(blockers(g).some((x) => x.code === "late_removal_disabled")).toBe(true);
  });

  test("a pending change request warns rather than blocks", () => {
    const d: Delivery = {
      id: 9,
      orders: [{ id: 1, hasChangeRequest: true, pieces: [myPiece] }],
    };
    const g = evaluateGuards({ intent: "remove", delivery: d, order: orderForGuards(d) });
    expect(g.find((x) => x.code === "change_request_pending")?.level).toBe("warn");
  });
});

describe("the monthly late-order counter is advisory", () => {
  test("zero remaining warns, never blocks", () => {
    const d: Delivery = { id: 1, availableMenuIds: [1], pastLateOrderDeadline: true, orders: [] };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      menuId: 1,
      user: { id: 7, remainingLateOrdersMonthOf: 0 },
    });
    expect(g.find((x) => x.code === "no_monthly_late_orders")?.level).toBe("warn");
    expect(blockers(g).some((x) => x.code === "no_monthly_late_orders")).toBe(false);
  });
});

describe("findOwnMeal across venues", () => {
  const ME = 501;
  const twoVenues: Delivery = {
    id: 9,
    orders: [
      { id: 1, menu: { id: 1 }, pieces: [{ ...myPiece, id: "a", userId: ME }] },
      { id: 2, menu: { id: 2 }, pieces: [{ ...myPiece, id: "b", userId: 999 }] },
      { id: 3, menu: { id: 3 }, pieces: [{ ...myPiece, id: "c", userId: ME }] },
    ],
  };

  test("collects every order the member holds a piece on", () => {
    const own = findOwnMeal(twoVenues, ME);
    expect(own?.orders.map((o) => o.order.id)).toEqual([1, 3]);
    expect(own?.ambiguous).toBe(true);
    expect(own?.order.id).toBe(1); // primary — writes act here
  });

  test("a guest's piece is never collected", () => {
    expect(ownPieces(twoVenues, ME).map((p) => p.id)).toEqual(["a", "c"]);
  });

  test("one venue is not ambiguous", () => {
    const one: Delivery = { id: 9, orders: [{ id: 1, pieces: [{ ...myPiece, userId: ME }] }] };
    expect(findOwnMeal(one, ME)?.ambiguous).toBe(false);
  });
});

describe("the replacement escape hatch is venue-scoped", () => {
  // A replacement at ONE venue must not unlock writes to a different venue on the same delivery.
  const d: Delivery = {
    id: 9,
    isReadOnly: true,
    availableMenuIds: [1, 2],
    orders: [
      { id: 1, menu: { id: 1 }, replaces: { id: 99, menu: { id: 1 } } },
      { id: 2, menu: { id: 2 } },
    ],
  };

  test("unlocks the venue that has the replacement", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 1),
      menuId: 1,
    });
    expect(blockers(g).some((x) => x.code === "delivery_read_only")).toBe(false);
  });

  test("does NOT unlock a different venue", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 2),
      menuId: 2,
    });
    expect(blockers(g).some((x) => x.code === "delivery_read_only")).toBe(true);
  });

  test("does NOT unlock a remove/skip, which names no target venue", () => {
    const g = evaluateGuards({ intent: "remove", delivery: d, order: orderForGuards(d) });
    expect(blockers(g).some((x) => x.code === "delivery_read_only")).toBe(true);
  });
});

describe("multi-venue writes target the right meal", () => {
  const ME = 501;
  // Meals at two venues: replacing the one at menu 2 must not destroy the one at menu 1.
  const twoVenues: Delivery = {
    id: 9,
    availableMenuIds: [1, 2],
    orders: [
      { id: 1, menu: { id: 1 }, pieces: [{ ...myPiece, id: "at-venue-1", menuId: 1, userId: ME }] },
      { id: 2, menu: { id: 2 }, pieces: [{ ...myPiece, id: "at-venue-2", menuId: 2, userId: ME }] },
    ],
  };

  test("findOwnMeal exposes the per-venue split needed to pick the right piece", () => {
    const own = findOwnMeal(twoVenues, ME)!;
    // The primary is venue 1, but a write to menu 2 must resolve to the venue-2 piece.
    expect(own.order.menu?.id).toBe(1);
    const target = own.orders.find((x) => x.order.menu?.id === 2);
    expect(target?.pieces[0]?.id).toBe("at-venue-2");
    expect(own.byIdentity).toBe(true);
  });

  test("byIdentity is false when nothing matched the user", () => {
    const guestOnly: Delivery = { id: 9, orders: [{ id: 1, pieces: [myPiece] }] };
    expect(findOwnMeal(guestOnly, ME)?.byIdentity).toBe(false);
    // ...and without a userId at all, there was no identity claim to begin with.
    expect(findOwnMeal(guestOnly)?.byIdentity).toBe(false);
  });
});
