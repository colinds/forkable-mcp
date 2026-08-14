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
  allowanceFor,
  isFamilyStyle,
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
  formatCountdown,
  groupSuffix,
  pieceBadges,
} from "@/order/format.ts";
import { fmtDelivery, compactDelivery, deliveryRange, addDaysLocal } from "@/tools.ts";
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
    expect(g.some((x) => x.code === "delivery_read_only")).toBe(true);
  });

  test("blocks a menu not in availableMenuIds", () => {
    const g = evaluateGuards({ intent: "select", delivery: baseDelivery, menuId: 999 });
    expect(g.some((x) => x.code === "menu_not_available")).toBe(true);
  });

  test("blocks over-capacity venue", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: baseDelivery,
      menuId: 6290,
      order: { id: 1, isOverVenueCapacity: true },
    });
    expect(g.some((x) => x.code === "over_venue_capacity")).toBe(true);
  });

  test("past deadline warns either way: no late orders left, or a late order still available", () => {
    const exhausted = evaluateGuards({
      intent: "select",
      delivery: { ...baseDelivery, pastLateOrderDeadline: true },
      menuId: 6290,
      order: { id: 1, changeRequestAllowed: true, lateOrdersRemaining: 0 },
    });
    // Advisory, not a refusal: the server owns this policy and reports it authoritatively.
    expect(exhausted.some((x) => x.code === "no_late_orders_remaining")).toBe(true);
    expect(blockers(exhausted).length).toBe(0);

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
  name: "Nebula Noodles",
  price: 18.99,
  autoOrder: true,
};

/** 4 venue orders, the user's meal on the LAST one — the shape that breaks `orders[0]`. */
const fourOrders: Delivery = {
  id: 1234199,
  availableMenuIds: [1, 2, 3, 4],
  orders: [
    { id: 1, menu: { id: 1, name: "Fixture Diner" }, lateOrdersRemaining: 0 },
    { id: 2, menu: { id: 2, name: "Taqueria Los Altos" }, lateOrdersRemaining: 6 },
    { id: 3, menu: { id: 3, name: "Kitava" }, lateOrdersRemaining: 6 },
    {
      id: 4,
      menu: { id: 4, name: "Placeholder Kitchen" },
      lateOrdersRemaining: 6,
      pieces: [myPiece],
    },
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
    expect(g.some((x) => x.code === "over_venue_capacity")).toBe(true);

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
    expect(g.some((x) => x.code === "over_venue_capacity")).toBe(false);
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
    expect(g.some((x) => x.code === "over_venue_capacity")).toBe(true);
  });

  test("late-order budget comes from your order, so a stale orders[0] can't block", () => {
    const d: Delivery = { ...fourOrders, pastLateOrderDeadline: true };
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 3),
      menuId: 3,
    });
    expect(g.some((x) => x.code === "no_late_orders_remaining")).toBe(false);
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
    { id: 1, menu: { id: 1, name: "Fixture Diner" } },
    {
      id: 4,
      menu: { id: 4, name: "Placeholder Kitchen" },
      venue: { id: 3, displayName: "Placeholder Kitchen" },
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
    expect(s.meal[0]?.venue).toBe("Placeholder Kitchen");
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
    expect(out).toContain("Nebula Noodles $18.99 — Placeholder Kitchen");
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

// --- Dropoff meal groups ----------------------------------------------------------------------

describe("meal groups", () => {
  const ME = 501;

  /** The observed single-meal shape: one piece, bagged into group A1. */
  const grouped: Delivery = {
    id: 1234200,
    forDeliveryAt: FOR_DELIVERY,
    orders: [
      {
        id: 1,
        venue: { id: 1, displayName: "Stub Street Cafe" },
        pieces: [{ ...myPiece, userId: ME, name: "Comet Curry", group: "A1" }],
      },
    ],
  };

  test("the piece's group comes through — the label, and only the label", () => {
    const s = deliveryStatus(grouped, ME);
    expect(s.meal[0]?.group).toBe("A1");
    expect(formatDeliveryStatus(s)).toContain("Comet Curry $18.99 — Stub Street Cafe — group A1");
  });

  test("each of several meals carries its OWN group, across venues", () => {
    const d: Delivery = {
      id: 3,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          ...grouped.orders![0]!,
          pieces: [
            { ...myPiece, id: "a", userId: ME, name: "Comet Curry", group: "A1" },
            // Same venue, DIFFERENT group — a per-delivery group field would flatten these.
            { ...myPiece, id: "b", userId: ME, name: "Meteor Melt", group: "A3" },
          ],
        },
        {
          id: 2,
          venue: { id: 2, displayName: "Mock Market Kitchen" },
          pieces: [{ ...myPiece, id: "c", userId: ME, name: "Quasar Bowl", group: "A5" }],
        },
      ],
    };
    const s = deliveryStatus(d, ME);
    expect(s.meal.map((m) => [m.name, m.group])).toEqual([
      ["Comet Curry", "A1"],
      ["Meteor Melt", "A3"],
      ["Quasar Bowl", "A5"],
    ]);
    const out = formatDeliveryStatus(s);
    expect(out).toContain("Meteor Melt $18.99 — Stub Street Cafe — group A3");
    expect(out).toContain("Quasar Bowl $18.99 — Mock Market Kitchen — group A5");
  });

  test("an ungrouped future delivery shows no group at all", () => {
    const d: Delivery = {
      id: 4,
      forDeliveryAt: FOR_DELIVERY,
      // Measured on a next-day delivery: the piece exists, grouping hasn't happened.
      orders: [{ id: 1, pieces: [{ ...myPiece, userId: ME, group: null }] }],
    };
    const s = deliveryStatus(d, ME);
    expect(s.meal[0]?.group).toBeNull();
    expect(formatDeliveryStatus(s)).not.toContain("group");
  });

  test("an absent group field is as good as null", () => {
    const d: Delivery = {
      id: 5,
      forDeliveryAt: FOR_DELIVERY,
      orders: [{ id: 1, pieces: [{ ...myPiece, userId: ME }] }],
    };
    expect(deliveryStatus(d, ME).meal[0]?.group).toBeNull();
    expect(formatDeliveryStatus(deliveryStatus(d, ME))).not.toContain("group");
  });

  test("a colleague's group is never reported as mine", () => {
    const d: Delivery = {
      id: 6,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          pieces: [
            { ...myPiece, id: "theirs", userId: ME + 1, name: "Their Burrito", group: "A7" },
            { ...myPiece, id: "mine", userId: ME, name: "Comet Curry", group: "A1" },
          ],
        },
      ],
    };
    const s = deliveryStatus(d, ME);
    expect(s.meal.map((m) => m.group)).toEqual(["A1"]);
    expect(formatDeliveryStatus(s)).not.toContain("A7");
  });

  test("one shared suffix, so the list and the status view can't drift", () => {
    expect(groupSuffix("A1")).toBe(" — group A1");
    expect(groupSuffix(null)).toBe("");
    expect(groupSuffix(undefined)).toBe("");
    // Both renderers spell it identically because both go through groupSuffix.
    const suffix = groupSuffix("A1");
    expect(fmtDelivery(grouped, undefined, ME)).toContain(`Comet Curry${suffix}`);
    expect(formatDeliveryStatus(deliveryStatus(grouped, ME))).toContain(
      `Stub Street Cafe${suffix}`,
    );
  });

  test("the list carries the group too — it's where to collect lunch", () => {
    expect(fmtDelivery(grouped, undefined, ME)).toContain("Comet Curry — group A1");
    expect(compactDelivery(grouped, undefined, ME).picked[0]?.group).toBe("A1");
  });

  test("the list omits an ungrouped meal's group rather than blanking it", () => {
    const d: Delivery = {
      id: 9,
      forDeliveryAt: FOR_DELIVERY,
      orders: [{ id: 1, pieces: [{ ...myPiece, userId: ME, name: "Comet Curry" }] }],
    };
    expect(fmtDelivery(d, undefined, ME)).toContain("Comet Curry\n");
    expect(fmtDelivery(d, undefined, ME)).not.toContain("group");
    expect(compactDelivery(d, undefined, ME).picked[0]?.group).toBeNull();
  });

  test("two meals in different groups are each labelled in the list", () => {
    const d: Delivery = {
      id: 10,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          pieces: [
            { ...myPiece, id: "a", userId: ME, name: "Comet Curry", group: "A1" },
            { ...myPiece, id: "b", userId: ME, name: "Meteor Melt", group: "A3" },
          ],
        },
      ],
    };
    expect(fmtDelivery(d, undefined, ME)).toContain(
      "Comet Curry — group A1, Meteor Melt — group A3",
    );
  });

  test("the list never labels a colleague's meal with its group", () => {
    const d: Delivery = {
      id: 11,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          pieces: [
            { ...myPiece, id: "theirs", userId: ME + 1, name: "Their Burrito", group: "A7" },
            { ...myPiece, id: "mine", userId: ME, name: "Comet Curry", group: "A1" },
          ],
        },
      ],
    };
    const line = fmtDelivery(d, undefined, ME);
    expect(line).toContain("Comet Curry — group A1");
    expect(line).not.toContain("A7");
    expect(line).toContain("+1 other meal");
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
    expect(g.some((x) => x.code === "change_request_not_allowed")).toBe(true);
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

  test("pieces with no userId are not claimed for anyone", () => {
    // fourOrders' piece carries no owner, so an identified lookup finds no meal rather than
    // guessing — guessing is what handed replacePiece a stranger's oldPieceId.
    expect(findOwnMeal(fourOrders, ME)).toBeUndefined();
    // Without an id there's no claim being made, so the day's meal is still shown.
    expect(findOwnMeal(fourOrders)?.order.id).toBe(4);
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
    expect(g.some((x) => x.code === "delivery_read_only")).toBe(false);
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
    expect(g.some((x) => x.code === "no_late_orders_remaining")).toBe(false);
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
    expect(g.some((x) => x.code === "no_late_removals_remaining")).toBe(false);
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
    expect(g.some((x) => x.code === "late_removal_disabled")).toBe(true);
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
    expect(g.some((x) => x.code === "delivery_read_only")).toBe(false);
  });

  test("does NOT unlock a different venue", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: d,
      order: orderForGuards(d, 2),
      menuId: 2,
    });
    expect(g.some((x) => x.code === "delivery_read_only")).toBe(true);
  });

  test("does NOT unlock a remove/skip, which names no target venue", () => {
    const g = evaluateGuards({ intent: "remove", delivery: d, order: orderForGuards(d) });
    expect(g.some((x) => x.code === "delivery_read_only")).toBe(true);
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

  test("someone else's meal is never returned as the member's", () => {
    const theirsOnly: Delivery = {
      id: 9,
      orders: [{ id: 1, pieces: [{ ...myPiece, userId: 999 }] }],
    };
    expect(findOwnMeal(theirsOnly, ME)).toBeUndefined();
    // Without an id there is no identity claim, so the result is flagged unattributed.
    expect(findOwnMeal(theirsOnly)?.byIdentity).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Club configurations this account can't reach: weekly allowances, family-style
// service, and deliveries carrying other members' orders.
// ---------------------------------------------------------------------------

describe("allowanceFor", () => {
  test("a daily club reads the daily copay and names it that", () => {
    const a = allowanceFor({ id: 1, allowanceType: "daily", copayAmount: 20 });
    expect(a).toEqual({ kind: "daily", limit: 20, label: "daily limit" });
  });

  test("a weekly club reads what's LEFT this week, not the daily copay", () => {
    const a = allowanceFor({
      id: 1,
      allowanceType: "weekly",
      copayAmount: 20,
      weeklyAllowance: 100,
      weeklyAllowanceAvailable: 35,
    });
    expect(a.limit).toBe(35);
    expect(a.label).toBe("remaining weekly allowance");
  });

  test("weekly with nothing left falls back to the weekly cap rather than reporting 0", () => {
    const a = allowanceFor({
      id: 1,
      allowanceType: "weekly_by_day",
      weeklyAllowance: 100,
      weeklyAllowanceAvailable: 0,
    });
    expect(a.limit).toBe(100);
    expect(a.label).toBe("weekly allowance");
  });

  test("an unknown allowance type never claims to be daily", () => {
    const a = allowanceFor({ id: 1, copayAmount: 20 });
    expect(a.label).toBe("company coverage");
    expect(a.label).not.toContain("daily");
  });

  test("a missing limit stays null so nothing is warned about", () => {
    expect(allowanceFor({ id: 1, allowanceType: "weekly" }).limit).toBeNull();
    expect(allowanceFor({ id: 1, allowanceType: "daily", copayAmount: 0 }).limit).toBeNull();
  });

  test("the receipt's clubCopay is the member's entitlement, beating the club-level copay", () => {
    // A club-level 20 with a member entitled to 35 — the club field can't express a per-member or
    // per-weekday allowance, so the receipt wins.
    const a = allowanceFor({
      id: 1,
      allowanceType: "daily",
      copayAmount: 20,
      userReceipt: { id: 1, clubCopay: 35 },
    });
    expect(a).toEqual({ kind: "daily", limit: 35, label: "daily limit" });
  });

  test("clubCopay wins for an unknown allowance type too, still without saying 'daily'", () => {
    const a = allowanceFor({ id: 1, copayAmount: 20, userReceipt: { id: 1, clubCopay: 31 } });
    expect(a.limit).toBe(31);
    expect(a.label).toBe("company coverage");
  });

  test("copayAmount is the fallback only when the receipt reports no entitlement at all", () => {
    const base = { id: 1, allowanceType: "daily", copayAmount: 20 };
    // No receipt yet, and a receipt that simply doesn't carry the field.
    expect(allowanceFor(base).limit).toBe(20);
    expect(allowanceFor({ ...base, userReceipt: { id: null, due: 0 } }).limit).toBe(20);
  });

  test("a member entitled to ZERO is not handed the club's figure", () => {
    // Zero means "unknown, stay silent" for a club-wide field, but a per-member receipt reporting 0
    // is a real answer: this member isn't covered on this delivery. Falling back to the club's $20
    // would promise coverage they don't have — so the limit goes null and nothing is claimed.
    const d: Delivery = {
      id: 1,
      forDeliveryAt: FOR_DELIVERY,
      allowanceType: "daily",
      copayAmount: 20,
      userReceipt: { id: 1, clubCopay: 0 },
      orders: [],
    };
    expect(allowanceFor(d).limit).toBeNull();
    // And nothing is rendered — silence, not "$0.00" and not the club's $20.
    expect(fmtDelivery(d)).not.toContain("company covers");
    expect(fmtDelivery(d)).not.toContain("$0.00");
  });

  test("the APPLIED copay is never mistaken for the limit", () => {
    // Measured live: clubCopay 20 (entitlement) alongside copayAmount 14.95 (what was applied).
    // Reading the receipt's copayAmount would shrink the allowance to the last thing ordered.
    const a = allowanceFor({
      id: 1,
      allowanceType: "daily",
      copayAmount: 20,
      userReceipt: { id: 1, clubCopay: 20, copayAmount: 14.95, subtotal: 14.95, due: 0 },
    });
    expect(a.limit).toBe(20);
  });

  test("a weekly club ignores clubCopay — the weekly pair still decides", () => {
    const a = allowanceFor({
      id: 1,
      allowanceType: "weekly",
      weeklyAllowance: 100,
      weeklyAllowanceAvailable: 35,
      userReceipt: { id: 1, clubCopay: 20 },
    });
    expect(a.limit).toBe(35);
    expect(a.label).toBe("remaining weekly allowance");
  });
});

describe("per-piece state badges", () => {
  const ME = 501;
  const deliveryWith = (piece: object): Delivery => ({
    id: 1234200,
    forDeliveryAt: FOR_DELIVERY,
    orders: [
      {
        id: 1,
        venue: { id: 1, displayName: "Stub Street Cafe" },
        pieces: [{ ...myPiece, userId: ME, name: "Comet Curry", ...piece }],
      },
    ],
  });

  test("an unconfirmed meal says so — it isn't going to be ordered", () => {
    const d = deliveryWith({ isConfirmed: false });
    expect(pieceBadges({ isConfirmed: false })).toBe(" [not confirmed]");
    expect(fmtDelivery(d, undefined, ME)).toContain("Comet Curry [not confirmed]");
    expect(formatDeliveryStatus(deliveryStatus(d, ME))).toContain("not confirmed");
  });

  test("a confirmed meal is not badged — the normal case stays quiet", () => {
    const d = deliveryWith({ isConfirmed: true });
    expect(pieceBadges({ isConfirmed: true })).toBe("");
    expect(fmtDelivery(d, undefined, ME)).toContain("Comet Curry\n");
    expect(fmtDelivery(d, undefined, ME)).not.toContain("confirmed");
  });

  test("null is 'not reported', NOT false — it must never read as unconfirmed", () => {
    expect(pieceBadges({ isConfirmed: null })).toBe("");
    expect(pieceBadges({})).toBe("");
    const d = deliveryWith({});
    expect(fmtDelivery(d, undefined, ME)).not.toContain("not confirmed");
    expect(deliveryStatus(d, ME).meal[0]?.isConfirmed).toBeNull();
  });

  test("a pending cancellation needs BOTH fields to agree", () => {
    expect(pieceBadges({ isRemoval: true, requestStatus: "pending" })).toBe(
      " [cancellation requested]",
    );
    // Either half alone means nothing landed.
    expect(pieceBadges({ isRemoval: true, requestStatus: "confirmed" })).toBe("");
    expect(pieceBadges({ isRemoval: null, requestStatus: "pending" })).toBe("");
    const d = deliveryWith({ isRemoval: true, requestStatus: "pending" });
    expect(fmtDelivery(d, undefined, ME)).toContain("cancellation requested");
    expect(deliveryStatus(d, ME).meal[0]?.cancellationPending).toBe(true);
  });

  test("the view model's folded flag renders the same as the raw pair", () => {
    expect(pieceBadges({ cancellationPending: true })).toBe(" [cancellation requested]");
  });

  test("a swappable meal and a late order are both flagged", () => {
    expect(pieceBadges({ isLateSwappable: true })).toBe(" [still swappable]");
    expect(pieceBadges({ isLateOrder: true })).toBe(" [late order]");
  });

  test("several states stack inside ONE bracket, worst news first", () => {
    // A bracketed group, not more em dashes: the dash already separates dish/venue/group, so
    // stacking states onto it left no way to see where the facts ended and the state began.
    expect(
      pieceBadges({
        isConfirmed: false,
        isRemoval: true,
        requestStatus: "pending",
        isLateSwappable: true,
        isLateOrder: true,
      }),
    ).toBe(" [not confirmed · cancellation requested · still swappable · late order]");
  });

  test("the bracket survives the list's comma-joined dishes", () => {
    const d: Delivery = {
      id: 12,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          pieces: [
            {
              ...myPiece,
              id: "a",
              userId: ME,
              name: "Comet Curry",
              group: "A5",
              isRemoval: true,
              requestStatus: "pending",
            },
            {
              ...myPiece,
              id: "b",
              userId: ME,
              name: "Meteor Melt",
              group: "A6",
              isLateOrder: true,
            },
          ],
        },
      ],
    };
    expect(fmtDelivery(d, undefined, ME)).toContain(
      "Comet Curry — group A5 [cancellation requested], Meteor Melt — group A6 [late order]",
    );
  });

  test("the unconfirmed consequence is a footnote, not more badge words", () => {
    const out = formatDeliveryStatus(deliveryStatus(deliveryWith({ isConfirmed: false }), ME));
    expect(out).toContain("[not confirmed]");
    expect(out).toContain("(an unconfirmed meal is not ordered — confirm_delivery to lock it in)");
    // The badge itself stays terse.
    expect(out).not.toContain("[not confirmed — won't be ordered]");
  });

  test("no footnote when every meal is confirmed or unreported", () => {
    for (const piece of [{ isConfirmed: true }, {}]) {
      const out = formatDeliveryStatus(deliveryStatus(deliveryWith(piece), ME));
      expect(out).not.toContain("unconfirmed meal");
    }
  });

  test("group and state coexist on one dish", () => {
    const d = deliveryWith({ group: "A1", isLateSwappable: true });
    expect(fmtDelivery(d, undefined, ME)).toContain("Comet Curry — group A1 [still swappable]");
  });

  test("a colleague's state is never badged onto my line", () => {
    const d: Delivery = {
      id: 5,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          pieces: [
            { ...myPiece, id: "theirs", userId: ME + 1, name: "Their Burrito", isConfirmed: false },
            { ...myPiece, id: "mine", userId: ME, name: "Comet Curry", isConfirmed: true },
          ],
        },
      ],
    };
    expect(fmtDelivery(d, undefined, ME)).not.toContain("not confirmed");
  });

  test("compactDelivery carries the state for a caller to branch on", () => {
    const p = compactDelivery(
      deliveryWith({ isConfirmed: false, isRemoval: true, requestStatus: "pending" }),
      undefined,
      ME,
    ).picked[0];
    expect(p?.isConfirmed).toBe(false);
    expect(p?.cancellationPending).toBe(true);
    expect(p?.isLateSwappable).toBeNull();
  });
});

describe("a delayed courier is loud", () => {
  const ME = 501;
  const withEta = (status: string, trackingUrl?: string): Delivery => ({
    id: 1234200,
    forDeliveryAt: FOR_DELIVERY,
    orders: [
      {
        id: 1,
        etaStatus: { status, start: ETA_START, end: "2026-08-11T11:50:00-07:00", trackingUrl },
        pieces: [{ ...myPiece, userId: ME }],
      },
    ],
  });

  test("delayed shouts and hands over the tracking link", () => {
    const d = withEta("delayed", "https://onf.lt/abc");
    expect(fmtDelivery(d, undefined, ME)).toContain("⚠ DELAYED — track: https://onf.lt/abc");
    const s = deliveryStatus(d, ME);
    expect(s.delayed).toBe(true);
    expect(formatDeliveryStatus(s)).toContain("⚠ DELAYED");
    expect(compactDelivery(d, undefined, ME).delayed).toBe(true);
  });

  test("delayed without a tracking link still shouts", () => {
    expect(fmtDelivery(withEta("delayed"), undefined, ME)).toContain("⚠ DELAYED");
    expect(fmtDelivery(withEta("delayed"), undefined, ME)).not.toContain("track:");
  });

  test("the other two enum values are left alone", () => {
    for (const status of ["ontime", "delivered"]) {
      const d = withEta(status);
      expect(fmtDelivery(d, undefined, ME)).toContain(status);
      expect(fmtDelivery(d, undefined, ME)).not.toContain("DELAYED");
      expect(deliveryStatus(d, ME).delayed).toBe(false);
      expect(formatDeliveryStatus(deliveryStatus(d, ME))).toContain(status);
    }
  });

  test("food on the table is not still late — both renderers agree", () => {
    const d: Delivery = {
      id: 10,
      forDeliveryAt: FOR_DELIVERY,
      club: { id: 1, market: { timezone: "America/Los_Angeles" } },
      orders: [
        {
          id: 1,
          // A stale `delayed` alongside a real arrival: the list already ranked arrival first, and
          // the status headline used to shout DELAYED directly above "Arrived".
          etaStatus: { status: "delayed", start: ETA_START, shortTz: "PT" },
          dropoffCompletedAt: "2026-08-11T18:41:44.000Z",
          pieces: [{ ...myPiece, userId: ME }],
        },
      ],
    };
    const s = deliveryStatus(d, ME);
    expect(s.delayed).toBe(false);
    expect(formatDeliveryStatus(s)).not.toContain("DELAYED");
    expect(formatDeliveryStatus(s)).toContain("Arrived");
    expect(fmtDelivery(d, undefined, ME)).not.toContain("DELAYED");
    expect(compactDelivery(d, undefined, ME).delayed).toBe(false);
  });

  test("no courier yet is not a delay", () => {
    const d: Delivery = { id: 6, forDeliveryAt: FOR_DELIVERY, orders: [] };
    expect(deliveryStatus(d).delayed).toBe(false);
    expect(formatDeliveryStatus(deliveryStatus(d))).toContain("not yet dispatched");
  });
});

describe("formatCountdown / the replacement clock", () => {
  const NOW = new Date("2026-08-12T18:00:00Z");
  const ME = 501;

  test("renders hours and minutes, then minutes alone", () => {
    expect(formatCountdown("2026-08-12T20:14:00Z", NOW)).toBe("2h 14m");
    expect(formatCountdown("2026-08-12T18:14:00Z", NOW)).toBe("14m");
    // A true offset is honoured as the instant it names (20:30Z), same as the app's fromISO —
    // NOT re-read as a host-local wall clock, which is what parseFloating would have done.
    expect(formatCountdown("2026-08-12T13:30:00-07:00", NOW)).toBe("2h 30m");
  });

  test("an elapsed or missing cutoff renders nothing rather than a negative", () => {
    expect(formatCountdown("2026-08-12T17:59:00Z", NOW)).toBe("");
    expect(formatCountdown("2026-08-12T18:00:00Z", NOW)).toBe("");
    expect(formatCountdown(undefined, NOW)).toBe("");
    expect(formatCountdown("not a date", NOW)).toBe("");
  });

  test("a replacement in flight tells the member how long they have", () => {
    const d: Delivery = {
      id: 7,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          replacementCutoffTs: "2026-08-12T20:14:00Z",
          pieces: [{ ...myPiece, userId: ME }],
        },
      ],
    };
    const s = deliveryStatus(d, ME, NOW);
    expect(s.replacementCountdown).toBe("2h 14m");
    expect(s.replacementCutoffRaw).toBe("2026-08-12T20:14:00Z");
    expect(formatDeliveryStatus(s)).toContain(
      "Re-pick by : 2h 14m left — the restaurant cancelled",
    );
  });

  test("an offset-less cutoff is refused rather than read as host-local", () => {
    // The family is unproven, so a value with no `Z` and no ±HH:MM has no instant to count down to.
    // Reading it with `new Date` would make the SAME wire value differ by host — which `test:tz`
    // could never catch, since every fixture we can write carries an offset.
    expect(formatCountdown("2026-08-12T20:14:00", NOW)).toBe("");
    expect(formatCountdown("2026-08-12", NOW)).toBe("");
  });

  test("a sub-minute window still reads 1m instead of vanishing", () => {
    expect(formatCountdown("2026-08-12T18:00:30Z", NOW)).toBe("1m");
  });

  test("the countdown scans every venue the member holds, not just the primary order", () => {
    // The member's SECOND venue is the one that cancelled — reading orders[0] said nothing about it
    // while happily rendering that venue's dish.
    const d: Delivery = {
      id: 11,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        { id: 1, pieces: [{ ...myPiece, id: "a", userId: ME }] },
        {
          id: 2,
          replacementCutoffTs: "2026-08-12T19:30:00Z",
          pieces: [{ ...myPiece, id: "b", userId: ME }],
        },
      ],
    };
    const s = deliveryStatus(d, ME, NOW);
    expect(s.meal).toHaveLength(2);
    expect(s.replacementCountdown).toBe("1h 30m");
    expect(formatDeliveryStatus(s)).toContain("Re-pick by");
  });

  test("the soonest OPEN window wins, by instant and not by string order", () => {
    const d: Delivery = {
      id: 12,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        // Same instant expressed two ways, plus a later one: "13:30-07:00" is 20:30Z, so sorting
        // these as strings would put the "19:30Z" order last and pick the wrong deadline.
        {
          id: 1,
          replacementCutoffTs: "2026-08-12T13:30:00-07:00",
          pieces: [{ ...myPiece, id: "a", userId: ME }],
        },
        {
          id: 2,
          replacementCutoffTs: "2026-08-12T19:30:00Z",
          pieces: [{ ...myPiece, id: "b", userId: ME }],
        },
      ],
    };
    expect(deliveryStatus(d, ME, NOW).replacementCountdown).toBe("1h 30m");
  });

  test("an elapsed window drops the countdown but still reports the cutoff", () => {
    const d: Delivery = {
      id: 13,
      forDeliveryAt: FOR_DELIVERY,
      orders: [
        {
          id: 1,
          replacementCutoffTs: "2026-08-12T17:00:00Z",
          pieces: [{ ...myPiece, userId: ME }],
        },
      ],
    };
    const s = deliveryStatus(d, ME, NOW);
    expect(s.replacementCountdown).toBeNull();
    // Not null: a caller can still tell "the re-pick window closed" from "no replacement at all".
    expect(s.replacementCutoffRaw).toBe("2026-08-12T17:00:00Z");
    expect(formatDeliveryStatus(s)).not.toContain("Re-pick");
  });

  test("no replacement means no line, and the raw value stays null", () => {
    const s = deliveryStatus(
      { id: 8, forDeliveryAt: FOR_DELIVERY, orders: [{ id: 1, pieces: [{ ...myPiece }] }] },
      undefined,
      NOW,
    );
    expect(s.replacementCountdown).toBeNull();
    expect(s.replacementCutoffRaw).toBeNull();
    expect(formatDeliveryStatus(s)).not.toContain("Re-pick");
  });
});

describe("money reaches the rendered line", () => {
  const ME = 501;
  const withReceipt = (receipt: Delivery["userReceipt"]): Delivery => ({
    id: 1234200,
    forDeliveryAt: FOR_DELIVERY,
    allowanceType: "daily",
    copayAmount: 20,
    userReceipt: receipt,
    orders: [{ id: 1, pieces: [{ ...myPiece, userId: ME }] }],
  });

  test("the list line shows the company limit and any out-of-pocket", () => {
    const line = fmtDelivery(withReceipt({ id: 1, clubCopay: 20, due: 4.5 }), undefined, ME);
    expect(line).toContain("company covers $20.00");
    expect(line).toContain("you pay $4.50");
  });

  test("nothing out of pocket prints no 'you pay' at all", () => {
    const line = fmtDelivery(withReceipt({ id: 1, clubCopay: 20, due: 0 }), undefined, ME);
    expect(line).toContain("company covers $20.00");
    expect(line).not.toContain("you pay");
  });

  test("the status view renders the same figures", () => {
    const s = deliveryStatus(withReceipt({ id: 1, clubCopay: 20, due: 4.5 }), ME);
    expect(s.companyLimit).toBe(20);
    expect(s.companyLimitLabel).toBe("daily limit");
    expect(s.youPay).toBe(4.5);
    expect(formatDeliveryStatus(s)).toContain("You pay    : $4.50");
  });

  test("an unknown limit renders no coverage claim rather than $0.00", () => {
    const d: Delivery = { id: 3, forDeliveryAt: FOR_DELIVERY, orders: [] };
    expect(fmtDelivery(d)).not.toContain("company covers");
    expect(compactDelivery(d).companyLimit).toBeNull();
  });
});

describe("the over-company-limit warning follows the club's allowance type", () => {
  test("a weekly club is measured against the weekly remainder, and says so", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: {
        id: 1,
        allowanceType: "weekly",
        copayAmount: 20,
        weeklyAllowance: 100,
        weeklyAllowanceAvailable: 12,
      },
      total: 18,
    });
    const w = g.find((x) => x.code === "over_company_limit");
    expect(w?.message).toContain("remaining weekly allowance");
    expect(w?.message).not.toContain("daily");
    expect(w?.data?.outOfPocket).toBe(6); // 18 - 12, not 18 - 20
  });

  test("an unknown limit warns about nothing", () => {
    const g = evaluateGuards({ intent: "select", delivery: { id: 1 }, total: 99 });
    expect(g.some((x) => x.code === "over_company_limit")).toBe(false);
  });

  test("a spend ceiling no longer suppresses the company-limit note", () => {
    const g = evaluateGuards({
      intent: "select",
      delivery: { id: 1, allowanceType: "daily", copayAmount: 20 },
      total: 25,
      maxTotal: 100,
    });
    expect(g.some((x) => x.code === "over_company_limit")).toBe(true);
    expect(blockers(g).length).toBe(0);
  });
});

describe("family-style deliveries", () => {
  const familyDay: Delivery = {
    id: 7,
    isReadOnly: true,
    canRequestChanges: true,
    forFamily: true,
    orders: [{ id: 1, menu: { id: 1 } }],
  };

  test("isFamilyStyle sees each of the four signals", () => {
    expect(isFamilyStyle(familyDay)).toBe(true);
    expect(isFamilyStyle({ id: 7, forBuffet: true })).toBe(true);
    expect(isFamilyStyle({ id: 7, club: { id: 1, familyHub: true } })).toBe(true);
    expect(isFamilyStyle({ id: 7, orders: [{ id: 1, venue: { id: 2, familyHub: true } }] })).toBe(
      true,
    );
    expect(isFamilyStyle({ id: 7, forFamily: null })).toBe(false);
  });

  test("a locked family day does not claim a change request is still accepted", () => {
    expect(deliveryWindow(familyDay).window).not.toBe("grace");
    expect(deliveryWindow(familyDay).note).not.toContain("change request");
  });

  test("the same day WITHOUT the family flag still reports grace", () => {
    expect(deliveryWindow({ ...familyDay, forFamily: false }).window).toBe("grace");
  });

  test("a remaining late-order budget still opens grace on a family day", () => {
    const w = deliveryWindow({ ...familyDay, orders: [{ id: 1, lateOrdersRemaining: 2 }] });
    expect(w.window).toBe("grace");
  });
});

describe("a delivery carrying another member's order", () => {
  const ME = 501;
  const THEM = 999;
  /** Their venue is listed first and is the only one with tracking — the shape that misattributes. */
  const shared: Delivery = {
    id: 9,
    forDeliveryAt: "2026-08-11T12:01:00.000Z",
    copayAmount: 20,
    allowanceType: "daily",
    orders: [
      {
        id: 1,
        menu: { id: 1, name: "Their Venue" },
        pieces: [{ id: "theirs", itemId: 1, menuId: 1, userId: THEM, name: "Their Burrito" }],
        dropoffCompletedAt: "2026-08-11T18:41:44.000Z",
        etaStatus: { start: "2026-08-11T11:35:00-07:00", status: "delivered", shortTz: "PT" },
      },
      {
        id: 2,
        menu: { id: 2, name: "My Venue" },
        pieces: [{ id: "mine", itemId: 2, menuId: 2, userId: ME, name: "My Noodles" }],
      },
    ],
  };

  test("get_delivery_status reports MY meal, not the first one ordered", () => {
    const s = deliveryStatus(shared, ME);
    expect(s.meal.map((m) => m.name)).toEqual(["My Noodles"]);
    expect(s.attributed).toBe(true);
  });

  test("their courier tracking is not reported as mine", () => {
    const s = deliveryStatus(shared, ME);
    expect(s.arrivedAt).toBeNull();
    expect(s.fulfillment).toBe("not yet dispatched");
    // Without an id it silently takes theirs — which is exactly the bug.
    expect(deliveryStatus(shared).fulfillment).toBe("delivered");
  });

  test("an unattributable meal is not called 'Your meal'", () => {
    const out = formatDeliveryStatus(deliveryStatus(shared));
    expect(out).toContain("couldn't tell which meal is yours");
    expect(out).not.toContain("Your meal");
  });

  test("the list shows only my pick, and counts the rest", () => {
    const line = fmtDelivery(shared, undefined, ME);
    expect(line).toContain("My Noodles");
    expect(line).not.toContain("Their Burrito");
    expect(line).toContain("+1 other meal");
  });

  test("someone else ordering does not make the day look ordered for me", () => {
    const theirsOnly: Delivery = { id: 9, orders: [shared.orders![0]!] };
    expect(compactDelivery(theirsOnly, undefined, ME).needsOrder).toBe(true);
    expect(compactDelivery(theirsOnly, undefined, ME).otherMeals).toBe(1);
  });

  test("a remove/skip resolves MY order, not the first with pieces", () => {
    expect(orderForGuards(shared, undefined, ME)?.id).toBe(2);
    expect(orderForGuards(shared)?.id).toBe(1); // the old, identity-free answer
  });
});

describe("two deliveries on one date", () => {
  const base: Delivery = { id: 1, forDeliveryAt: "2026-08-11T12:01:00.000Z", orders: [] };
  const lunch: Delivery = {
    ...base,
    id: 100,
    serviceWindow: { name: "lunch" },
    club: { id: 1, name: "HQ" },
  };
  const dinner: Delivery = {
    ...base,
    id: 101,
    serviceWindow: { name: "afternoon" },
    club: { id: 1, name: "HQ" },
  };

  test("the service window distinguishes them, with 'afternoon' shown as dinner", () => {
    expect(fmtDelivery(lunch)).toContain("lunch");
    expect(fmtDelivery(dinner)).toContain("dinner");
    expect(fmtDelivery(dinner)).not.toContain("afternoon");
  });

  test("the club name is rendered, so two clubs on one day are tellable apart", () => {
    expect(fmtDelivery(lunch)).toContain("HQ");
    expect(compactDelivery(dinner).service).toBe("dinner");
    expect(compactDelivery(lunch).club).toBe("HQ");
  });
});

/**
 * `myDeliveries(from:)` alone is week-bucketed — it answers with only the calendar week containing
 * `from`. Nine lookups once called the loader without a `to` and so could not resolve any id past
 * the current week: on a Friday, every delivery from Monday on was invisible to `get_menus`,
 * `set_meal` and the rest, while `list_deliveries` (which did pass a `to`) listed them happily.
 */
describe("delivery lookups always query a range", () => {
  test("both bounds are always present — the omission that caused the bug", () => {
    for (const r of [deliveryRange(), deliveryRange("2026-08-14")]) {
      expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the default window reaches past the end of the current week, whatever day it is", () => {
    const r = deliveryRange();
    // 21 days clears a week boundary from any weekday — the condition that failed on a Friday.
    expect(r.to).toBe(addDaysLocal(r.from, 21));
    expect(r.to > r.from).toBe(true);
  });

  test("addDaysLocal is pure calendar arithmetic, across a month boundary", () => {
    expect(addDaysLocal("2026-08-14", 21)).toBe("2026-09-04");
    expect(addDaysLocal("2026-08-14", -14)).toBe("2026-07-31");
    expect(addDaysLocal("2026-08-14", 0)).toBe("2026-08-14");
  });

  test("a leap day and a year boundary survive the round trip", () => {
    expect(addDaysLocal("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysLocal("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("a `from` beyond the horizon still yields a forwards range, not a backwards one", () => {
    // The old code paired a far-future `from` with a `to` of today+21, which is a range that
    // matches nothing at all.
    const r = deliveryRange("2099-12-01");
    expect(r.to > r.from).toBe(true);
    expect(r.to).toBe("2099-12-22");
  });

  test("a backdated `from` keeps the horizon at today+21 rather than 21 days after `from`", () => {
    // get_delivery_status looks back 14 days; its window must still reach upcoming deliveries.
    const r = deliveryRange(addDaysLocal(deliveryRange().from, -14));
    expect(r.to).toBe(deliveryRange().to);
  });

  test("an explicit `to` wins outright, so a window can END in the past", () => {
    // The whole point: without this, `to` floors at today+21 and a historical question comes back
    // padded with upcoming deliveries, which reads as an answer.
    expect(deliveryRange("2026-08-03", "2026-08-07")).toEqual({
      from: "2026-08-03",
      to: "2026-08-07",
    });
  });

  test("an explicit `to` is never widened to the horizon, even when it is close in", () => {
    const r = deliveryRange(undefined, "2026-08-14");
    expect(r.to).toBe("2026-08-14");
    expect(r.from).toBe(deliveryRange().from);
  });
});
