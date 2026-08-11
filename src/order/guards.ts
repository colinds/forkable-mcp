// Ordering guards: what to TELL the caller before a write, not a second copy of the server's rules.
//
// Forkable enforces its own policy and reports refusals with structured codes, so almost everything
// here is a `warn` — context the agent can act on, attached to a preview it still has to confirm.
// Blocking on our reading of someone else's policy is how you refuse a write the server would have
// accepted, and our model is only ever as good as the one club it was written against.
//
// Exactly two things still `block`, and neither is Forkable's call:
//   • over_total_ceiling — the operator's own FORKABLE_MAX_TOTAL spend cap
//   • selection_invalid  — the selectionsHash WE build is malformed; that's our bug to catch

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
  /** These pieces are known to be the member's. False = "whoever ordered", so don't call them theirs. */
  byIdentity: boolean;
}

/**
 * The member's meal(s) on a delivery. One order per venue, and a member may hold pieces on SEVERAL of
 * them, at indexes that move day to day — so never index into `orders`.
 *
 * **Always pass `userId`.** Without it this is merely "orders that have pieces": a delivery carrying a
 * colleague's order then resolves to their meal, which misreports whose lunch it is and would hand
 * `replacePiece` the wrong `oldPieceId`. With it, no match means the member genuinely has no meal —
 * `undefined`, never a stranger's. Every piece selection carries `userId`, and `loadDeliveries` returns
 * the id alongside the deliveries, so there is no path that legitimately lacks one.
 */
export function findOwnMeal(d: Delivery, userId?: number): OwnMeal | undefined {
  const mine: OwnOrder[] = (d.orders ?? []).flatMap((o) => {
    const all = o.pieces ?? [];
    const ps = userId == null ? all : all.filter((p) => p.userId === userId);
    return ps.length ? [{ order: o, pieces: ps }] : [];
  });
  const first = mine[0];
  if (!first) return undefined;
  return {
    order: first.order,
    pieces: first.pieces,
    orders: mine,
    ambiguous: mine.length > 1,
    byIdentity: userId != null,
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
export function orderForGuards(d: Delivery, menuId?: number, userId?: number): Order | undefined {
  const orders = d.orders ?? [];
  const selling = menuId != null ? orders.find((o) => o.menu?.id === menuId) : undefined;
  // Identity matters on branch 2: without it, a delivery carrying someone else's order can hand a
  // remove/skip/confirm the wrong venue's counters.
  const own = findOwnMeal(d, userId)?.order;
  return selling ?? own ?? (orders.length === 1 ? orders[0] : undefined);
}

/**
 * What the company actually covers, and what to call it.
 *
 * `copayAmount` is the DAILY figure and is only the answer on a daily club; a weekly club's budget
 * lives in the weekly fields. Never say "daily" unless `allowanceType` says so.
 *
 * A null limit means "we don't know" and must stay silent — callers already skip the warning unless
 * the limit is a positive number. `weeklyAllowanceAvailable` in particular reads 0 on a daily club,
 * so it's only consulted when the club really is weekly.
 */
export interface Allowance {
  kind: string;
  limit: number | null;
  label: string;
}

const positive = (n?: number | null): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;

export function allowanceFor(d: Delivery): Allowance {
  const kind = d.allowanceType ?? d.club?.allowanceType ?? "";
  if (kind === "weekly" || kind === "weekly_by_day") {
    const left = positive(d.weeklyAllowanceAvailable);
    return left != null
      ? { kind, limit: left, label: "remaining weekly allowance" }
      : { kind, limit: positive(d.weeklyAllowance), label: "weekly allowance" };
  }
  if (kind === "daily") return { kind, limit: positive(d.copayAmount), label: "daily limit" };
  // Unknown allowance type: the daily field is the best guess, but don't name it "daily".
  return { kind: kind || "unknown", limit: positive(d.copayAmount), label: "company coverage" };
}

/** Family-style service — the meal is shared, so a per-member change request never applies. */
export function isFamilyStyle(d: Delivery): boolean {
  return Boolean(
    d.forFamily ||
    d.forBuffet ||
    d.club?.familyHub ||
    (d.orders ?? []).some((o) => o.venue?.familyHub),
  );
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
  // Family-style days never offer one, so the affordance doesn't apply there — only this source of
  // `grace` is suppressed; a remaining late-order budget is a separate affordance and still counts.
  const changeAllowed =
    !isFamilyStyle(d) &&
    (d.canRequestChanges === true || orders.some((o) => o.changeRequestAllowed === true));
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
  | "diet_conflict"
  | "diet_check_unavailable"
  | "instructions_not_supported";

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
      level: "warn",
      message: "This delivery reads as locked; the server may refuse the write.",
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
        level: "warn",
        message: `Menu ${c.menuId} isn't listed as available for this delivery; the server may refuse it.`,
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
        level: "warn",
        message: "The venue reads as over capacity; the server may refuse the write.",
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
    // Spend limits. A user-set FORKABLE_MAX_TOTAL is a HARD cap (block over it); the company-limit
    // note is independent of it and fires on its own.
    // An unknown/non-finite total never blocks (hidePrices clubs report no total), and an unknown
    // limit says nothing at all rather than guessing.
    // `allowanceMealLimit` (the company covers one meal a day) deliberately does NOT feed this: every
    // set_meal REPLACES a piece rather than adding one, so a write never turns a first meal into a
    // second. get_profile reports the policy instead.
    const total = c.total;
    const allowance = allowanceFor(d);
    const companyLimit = allowance.limit;
    const known = typeof total === "number" && Number.isFinite(total);
    const overCompany = known && companyLimit != null ? Math.max(total - companyLimit, 0) : 0;
    if (c.maxTotal != null && known && total > c.maxTotal) {
      g.push({
        code: "over_total_ceiling",
        level: "block",
        message: `This order totals ${formatMoney(total)}, over the ${formatMoney(c.maxTotal)} ceiling (FORKABLE_MAX_TOTAL).`,
        data: { total, maxTotal: c.maxTotal },
      });
    }
    if (overCompany > 0) {
      g.push({
        code: "over_company_limit",
        level: "warn",
        message: `This meal totals ${formatMoney(total)}, over your company's ${allowance.label} of ${formatMoney(companyLimit)} — about ${formatMoney(overCompany)} out of pocket.`,
        data: { total, companyLimit, outOfPocket: overCompany, allowanceType: allowance.kind },
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
          level: "warn",
          message:
            "Past the ordering deadline, and this delivery doesn't report a change-request " +
            "affordance — the server will likely refuse.",
        });
      } else if (
        !replacementOpen &&
        o &&
        typeof o.lateOrdersRemaining === "number" &&
        o.lateOrdersRemaining <= 0
      ) {
        g.push({
          code: "no_late_orders_remaining",
          level: "warn",
          message: "Past the deadline and this venue reports no late orders remaining.",
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
        level: "warn",
        message: "This club reports late removals as disabled; the server may refuse.",
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
          level: "warn",
          message: "Past the deadline and this order reports no late removals remaining.",
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
