// Ordering guards. `block` guards prevent a write; `warn` guards are advisory.

import { type Delivery, type Order, type Piece } from "./types.ts";
import { type SelectionViolation } from "./selections.ts";
import { formatMoney } from "./format.ts";

/** One venue's worth of the member's meal: the order plus the pieces they own on it. */
export interface OwnOrder {
  order: Order;
  pieces: Piece[];
}

export interface OwnMeal {
  /** The primary order — the first carrying the member's pieces. Writes act on this one. */
  order: Order;
  pieces: Piece[];
  /** EVERY order carrying the member's pieces, primary first. Length > 1 is legitimate. */
  orders: OwnOrder[];
  /** Meals at more than one venue today. Not an error — the member may genuinely hold several. */
  ambiguous: boolean;
  /** True when pieces were matched by `userId`. False means these may belong to someone else. */
  byIdentity: boolean;
}

/**
 * The member's meal(s) on a delivery. One order per venue, and a member may hold pieces on SEVERAL of
 * them (an extra meal is allowed unless the club caps it), at indexes that move day to day — so never
 * index into `orders`.
 *
 * Pass `userId` on any path that will WRITE: without it this is just "orders that have pieces", which
 * on a delivery carrying a guest order can resolve to someone else's meal and hand `replacePiece` the
 * wrong `oldPieceId`.
 */
export function findOwnMeal(d: Delivery, userId?: number): OwnMeal | undefined {
  const orders = d.orders ?? [];
  const mine: OwnOrder[] =
    userId == null
      ? orders.flatMap((o) =>
          (o.pieces?.length ?? 0) > 0 ? [{ order: o, pieces: o.pieces ?? [] }] : [],
        )
      : orders.flatMap((o) => {
          const ps = (o.pieces ?? []).filter((p) => p.userId === userId);
          return ps.length ? [{ order: o, pieces: ps }] : [];
        });
  // A userId that matched nothing means the field wasn't selected (or is an older payload); fall back
  // to "any order with pieces" rather than reporting the member has no meal.
  const resolved =
    mine.length || userId == null
      ? mine
      : orders.flatMap((o) =>
          (o.pieces?.length ?? 0) > 0 ? [{ order: o, pieces: o.pieces ?? [] }] : [],
        );
  const first = resolved[0];
  if (!first) return undefined;
  return {
    order: first.order,
    pieces: first.pieces,
    orders: resolved,
    ambiguous: resolved.length > 1,
    byIdentity: userId != null && mine.length > 0,
  };
}

/** Every piece the member owns across all venues today. */
export function ownPieces(d: Delivery, userId?: number): Piece[] {
  return findOwnMeal(d, userId)?.orders.flatMap((o) => o.pieces) ?? [];
}

/** Every piece across all per-venue orders. For DISPLAY — includes guest picks. */
export function allPieces(d: Delivery): Piece[] {
  return (d.orders ?? []).flatMap((o) => o.pieces ?? []);
}

/**
 * The order a guard should read counters off:
 *  1. the one selling `menuId`, when given — capacity and the late-order budget belong to the venue
 *     you're JOINING, which is not your current one on a cross-venue switch;
 *  2. else the one holding your pieces (no menuId: a remove/skip/confirm);
 *  3. else the sole order, if there is only one.
 *
 * Deliberately `undefined` rather than `orders[0]` in a multi-order club with no match: an arbitrary
 * venue's `lateOrdersRemaining` is worse than none, since delivery-level gates still apply.
 */
export function orderForGuards(d: Delivery, menuId?: number): Order | undefined {
  const orders = d.orders ?? [];
  const selling = menuId != null ? orders.find((o) => o.menu?.id === menuId) : undefined;
  const own = findOwnMeal(d)?.order;
  return selling ?? own ?? (orders.length === 1 ? orders[0] : undefined);
}

/**
 * Which writes a delivery still accepts.
 *
 * There is no member-facing deadline field. `editingCutoffAt` looks like one and is not — it carries
 * buffet/Events semantics, and a Friday delivery was observed carrying a Tuesday cutoff while still
 * accepting writes hours later. It is no longer selected. The policy is fixed — 2pm the day before for a
 * normal edit, 9am on the day for a late order — so decide with the booleans:
 *  - `isReadOnly` — the delivery is locked to normal editing (true on days that really are shut).
 *  - `pastLateOrderDeadline` — strictly later; even a late order or change request is refused.
 *
 * Note this is a pure function of the delivery's flags — no clock is consulted, because there is no
 * timestamp worth comparing against.
 *
 * A locked-but-not-past-deadline delivery is the grace period: it reads shut, but a late order or change
 * request may still land. Deliberately permissive — the real gating is per OPERATION (an add needs
 * `lateOrdersRemaining > 0 && changeRequestAllowed`; a late swap needs only `!pastLateOrderDeadline`),
 * and `evaluateGuards` enforces that per intent. Narrowing this coarse signal would report "closed" on a
 * day where a swap still works.
 */
export type WriteWindow = "open" | "grace" | "closed";

export interface DeliveryWindow {
  window: WriteWindow;
  pastLateOrderDeadline: boolean;
  note: string;
}

export function deliveryWindow(d: Delivery): DeliveryWindow {
  const orders = d.orders ?? [];
  const pastLate = Boolean(d.pastLateOrderDeadline || orders.some((o) => o.pastLateOrderDeadline));
  // `canRequestChanges` is the grace-period affordance: it's false on a normally-open delivery and
  // true once editing has closed but a change request is still accepted.
  const changeAllowed =
    d.canRequestChanges === true || orders.some((o) => o.changeRequestAllowed === true);
  const lateOrdersLeft = orders.some(
    (o) => typeof o.lateOrdersRemaining === "number" && o.lateOrdersRemaining > 0,
  );

  let window: WriteWindow;
  let note: string;
  // No timestamp in any of these — the policy is "2pm the day before" for a normal edit and "9am on
  // the day" for a late order; the API exposes no member-facing deadline field.
  if (!d.isReadOnly && !pastLate) {
    window = "open";
    note = "Editable — normally until 2pm the day before delivery.";
  } else if (!pastLate && (changeAllowed || lateOrdersLeft)) {
    window = "grace";
    note =
      "Editing closed, but a late order or change request is still accepted (until 9am on the day).";
  } else {
    window = "closed";
    note = pastLate
      ? "Past the late-order deadline; no further changes."
      : "Locked — no late-order budget or change-request affordance left.";
  }
  return { window, pastLateOrderDeadline: pastLate, note };
}

export type GuardCode =
  | "delivery_read_only"
  | "menu_not_available"
  | "past_late_order_deadline"
  | "change_request_not_allowed"
  | "over_venue_capacity"
  | "no_late_orders_remaining"
  | "no_late_removals_remaining"
  | "selection_invalid"
  | "over_total_ceiling"
  | "over_company_limit"
  | "no_credit_card"
  | "multiple_own_orders"
  | "sibling_replacement_pending"
  | "no_monthly_late_orders"
  | "late_removal_disabled"
  | "change_request_pending"
  | "diet_conflict";

export interface Guard {
  code: GuardCode;
  level: "block" | "warn";
  message: string;
  data?: Record<string, unknown>;
}

export interface GuardContext {
  /** `skip` is deliberately absent: skipping a day IS removing your piece, so it uses "remove". */
  intent: "select" | "remove" | "confirm";
  delivery: Delivery;
  /** The order being written INTO (target venue on a select). */
  order?: Order;
  /**
   * The order being written OUT OF, when a select moves your meal between venues. `replacePiece`
   * touches both, so a gate on either one has to be honored — reading only the target silently
   * drops the source's `changeRequestAllowed`.
   */
  sourceOrder?: Order;
  menuId?: number;
  violations?: SelectionViolation[];
  /** Account-level capability signals (from `me`), used to refuse hopeless orders early. */
  user?: { id?: number; validCreditCard?: boolean; remainingLateOrdersMonthOf?: number };
  /** Order total (dollars, base + add-ons) and an optional hard spend ceiling. */
  total?: number;
  maxTotal?: number;
}

/** Evaluate ordering guards; `block` guards prevent the write, `warn` are advisory. */
export function evaluateGuards(c: GuardContext): Guard[] {
  const g: Guard[] = [];
  const d = c.delivery;
  const o = c.order;
  // Rolled up across every order, matching deliveryWindow(), so the deadline gate survives even when
  // no specific order resolved — otherwise a multi-venue day with no target row loses it entirely.
  const pastDeadline =
    d.pastLateOrderDeadline || (d.orders ?? []).some((x) => x.pastLateOrderDeadline);
  // Both ends of a cross-venue move must permit the change.
  const changeRefused = [o, c.sourceOrder].some((x) => x?.changeRequestAllowed === false);
  const orders = d.orders ?? [];

  /**
   * A venue-replacement in flight re-opens THAT venue: when the order selling the menu you're writing
   * to carries `replaces` and the menu is still offered, the write is accepted past the normal gates.
   *
   * Scoped to `menuId` deliberately. A replacement at one venue must not unlock writes to a different
   * one, and with no `menuId` (remove/skip/confirm) there is no target venue to unlock.
   */
  const replacementOpen =
    c.menuId != null &&
    (d.availableMenuIds ?? []).includes(c.menuId) &&
    orders.some((x) => x.replaces && x.menu?.id === c.menuId);

  if (d.isReadOnly && !replacementOpen) {
    g.push({
      code: "delivery_read_only",
      level: "block",
      message: "This delivery is read-only (locked).",
    });
  }

  // A pending replacement, or a late replacement anywhere on the delivery, freezes SIBLING meals too —
  // so a delivery that looks open per its own flags can still be frozen. Warn rather than block: this
  // is modelled from behavior we have not yet observed live.
  const frozenBySibling =
    orders.some((x) => x.replaces && x.menu?.id !== c.menuId && x.id !== o?.id) ||
    orders.some((x) => (x.pieces ?? []).some((pc) => pc.flowType === "late_replacement"));
  if (frozenBySibling && c.intent !== "confirm") {
    g.push({
      code: "sibling_replacement_pending",
      level: "warn",
      message:
        "Another venue on this delivery has a replacement in flight, which can freeze every meal on " +
        "the day — this write may be refused even though the delivery reads as open.",
    });
  }

  // Several venues in one day is legitimate (an extra meal), but a write only touches one — say which.
  const own = findOwnMeal(d, c.user?.id);
  if (own?.ambiguous) {
    const venues = own.orders
      .map((x) => x.order.venue?.displayName ?? x.order.menu?.name ?? `order ${x.order.id}`)
      .join(", ");
    g.push({
      code: "multiple_own_orders",
      level: "warn",
      message: `You have meals at ${own.orders.length} venues today (${venues}); acting on ${own.order.venue?.displayName ?? own.order.menu?.name ?? own.order.id}.`,
      data: { orderId: own.order.id, orderIds: own.orders.map((x) => x.order.id) },
    });
  }

  if (c.intent === "select") {
    if (c.menuId != null && d.availableMenuIds && !d.availableMenuIds.includes(c.menuId)) {
      g.push({
        code: "menu_not_available",
        level: "block",
        message: `Menu ${c.menuId} is not available for this delivery.`,
        data: { availableMenuIds: d.availableMenuIds },
      });
    }
    // Capacity never applies to the venue you're already on — re-customizing your existing meal
    // doesn't consume a new seat.
    // Requires a real `userId` match: a guest's meal at that venue is not you "staying put", and
    // treating it as such silently suppressed the capacity block.
    const stayingPut =
      c.menuId != null &&
      own?.byIdentity === true &&
      own.orders.some((x) => x.order.menu?.id === c.menuId);
    if (o?.isOverVenueCapacity && !stayingPut) {
      g.push({
        code: "over_venue_capacity",
        level: "block",
        message: "The venue is over capacity; changes are blocked.",
      });
    }
    for (const v of c.violations ?? []) {
      g.push({
        code: "selection_invalid",
        level: "block",
        message: selectionViolationMessage(v),
        data: { ...v },
      });
    }
    // Spend limits. A user-set FORKABLE_MAX_TOTAL is a HARD cap (block over it). Otherwise, if the meal
    // exceeds the company's daily limit (delivery.copayAmount), just note the out-of-pocket amount.
    // An unknown/non-finite total never blocks (hidePrices clubs report no total).
    const total = c.total;
    const companyLimit = d.copayAmount;
    const overCompany =
      typeof total === "number" &&
      Number.isFinite(total) &&
      typeof companyLimit === "number" &&
      companyLimit > 0
        ? total - companyLimit
        : 0;
    if (c.maxTotal != null) {
      if (typeof total === "number" && Number.isFinite(total) && total > c.maxTotal) {
        g.push({
          code: "over_total_ceiling",
          level: "block",
          message: `This order totals ${formatMoney(total)}, over the ${formatMoney(c.maxTotal)} ceiling (FORKABLE_MAX_TOTAL).`,
          data: { total, maxTotal: c.maxTotal },
        });
      }
    } else if (overCompany > 0) {
      g.push({
        code: "over_company_limit",
        level: "warn",
        message: `This meal totals ${formatMoney(total)}, over your company's daily limit of ${formatMoney(companyLimit)} — about ${formatMoney(overCompany)} out of pocket.`,
        data: { total, companyLimit, outOfPocket: overCompany },
      });
    }
    // Advisory only: the monthly counter is a display figure, and the real budget is the order-level
    // `lateOrdersRemaining`. Blocking on it refused writes the API would have accepted.
    if (c.user?.remainingLateOrdersMonthOf === 0) {
      g.push({
        code: "no_monthly_late_orders",
        level: "warn",
        message: "Your monthly late-order counter reads zero; this write may be refused.",
      });
    }
    if (pastDeadline) {
      if (changeRefused) {
        g.push({
          code: "change_request_not_allowed",
          level: "block",
          message:
            "Past the ordering deadline and change requests aren't allowed for this delivery.",
        });
      } else if (
        !replacementOpen &&
        o &&
        typeof o.lateOrdersRemaining === "number" &&
        o.lateOrdersRemaining <= 0
      ) {
        g.push({
          code: "no_late_orders_remaining",
          level: "block",
          message: "Past the deadline and you have no late orders remaining this month.",
        });
      } else {
        g.push({
          code: "past_late_order_deadline",
          level: "warn",
          message:
            "Past the normal deadline — this will be submitted as a late order/change request.",
        });
      }
    }
    if (c.user?.validCreditCard === false && overCompany > 0) {
      g.push({
        code: "no_credit_card",
        level: "warn",
        message: "No credit card on file — the out-of-pocket amount may fail to charge.",
      });
    }
  }

  if (c.intent === "remove") {
    if (d.club?.isLateRemovalEnabled === false && pastDeadline) {
      g.push({
        code: "late_removal_disabled",
        level: "block",
        message: "This club doesn't allow late removals.",
      });
    }
    if (o?.hasChangeRequest) {
      g.push({
        code: "change_request_pending",
        level: "warn",
        message: "This order already has a change request in flight; another may be refused.",
      });
    }
    // A delivery still in `initial` accepts a removal even past the late deadline.
    if (pastDeadline && d.state !== "initial") {
      if (o && typeof o.lateRemovalsRemaining === "number" && o.lateRemovalsRemaining <= 0) {
        g.push({
          code: "no_late_removals_remaining",
          level: "block",
          message: "Past the deadline and you have no late removals remaining.",
        });
      } else {
        g.push({
          code: "past_late_order_deadline",
          level: "warn",
          message: "Past the normal deadline — removing now counts as a late removal.",
        });
      }
    }
  }

  return g;
}

export function blockers(guards: Guard[]): Guard[] {
  return guards.filter((g) => g.level === "block");
}

function selectionViolationMessage(v: SelectionViolation): string {
  switch (v.code) {
    case "required":
      return `You must choose an option for "${v.label}".`;
    case "below_min":
      return `"${v.label}" needs at least ${v.min} selection(s) (you chose ${v.selected}).`;
    case "above_max":
      return `"${v.label}" allows at most ${v.max} selection(s) (you chose ${v.selected}).`;
    case "unknown_option":
      return `An option you picked for "${v.label}" doesn't exist on this item.`;
    case "unknown_modifier":
      return `"${v.label}" is not a modifier on this item.`;
  }
}
