// Ordering guards. `block` guards prevent a write; `warn` guards are advisory.

import { type Delivery, type Order } from "./types.ts";
import { type SelectionViolation } from "./selections.ts";
import { formatMoney, formatDateTime, isPast } from "./format.ts";

/**
 * Forkable gates writes twice, and `editingCutoffAt` is only the FIRST gate:
 *
 *  - `editingCutoffAt` — when normal editing closes. Passing it flips `isReadOnly` to true.
 *  - `pastLateOrderDeadline` — a strictly later gate, after which even a late order or change
 *    request is refused. This is the one the guards below key off.
 *
 * Between the two sits a grace period (`state: "grace_period"`, `canRequestChanges: true`) where a
 * delivery reads as locked but a change request still goes through. Reporting only the cutoff makes
 * a still-editable delivery look shut, so callers get the window, not just the timestamp.
 */
export type WriteWindow = "open" | "grace" | "closed";

export interface DeliveryWindow {
  window: WriteWindow;
  /** The editing cutoff, verbatim from the API (may already have passed). */
  editingCutoffAt: string | null;
  cutoffPassed: boolean;
  pastLateOrderDeadline: boolean;
  note: string;
}

export function deliveryWindow(d: Delivery, now: Date = new Date()): DeliveryWindow {
  const orders = d.orders ?? [];
  const pastLate = Boolean(d.pastLateOrderDeadline || orders.some((o) => o.pastLateOrderDeadline));
  const cutoffPassed = isPast(d.editingCutoffAt, now) ?? false;
  // `canRequestChanges` is the grace-period affordance: it's false on a normally-open delivery and
  // true once editing has closed but a change request is still accepted.
  const changeAllowed =
    d.canRequestChanges === true || orders.some((o) => o.changeRequestAllowed === true);
  const lateOrdersLeft = orders.some(
    (o) => typeof o.lateOrdersRemaining === "number" && o.lateOrdersRemaining > 0,
  );

  const cutoff = d.editingCutoffAt ?? null;
  const when = cutoff ? formatDateTime(cutoff) : "unknown";
  let window: WriteWindow;
  let note: string;
  if (!cutoffPassed && !pastLate && !d.isReadOnly) {
    window = "open";
    note = cutoff ? `Editable until ${when}.` : "Editable.";
  } else if (!pastLate && (changeAllowed || lateOrdersLeft)) {
    window = "grace";
    note = `Editing closed ${when}, but a late change request is still accepted.`;
  } else {
    window = "closed";
    note = pastLate
      ? `Past the late-order deadline (editing closed ${when}); no further changes.`
      : `Locked (editing closed ${when}).`;
  }
  return {
    window,
    editingCutoffAt: cutoff,
    cutoffPassed,
    pastLateOrderDeadline: pastLate,
    note,
  };
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
  | "delivery_not_initial";

export interface Guard {
  code: GuardCode;
  level: "block" | "warn";
  message: string;
  data?: Record<string, unknown>;
}

export interface GuardContext {
  intent: "select" | "remove" | "confirm" | "skip";
  delivery: Delivery;
  order?: Order;
  menuId?: number;
  violations?: SelectionViolation[];
  /** Account-level capability signals (from `me`), used to refuse hopeless orders early. */
  user?: { validCreditCard?: boolean; remainingLateOrdersMonthOf?: number };
  /** Order total (dollars, base + add-ons) and an optional hard spend ceiling. */
  total?: number;
  maxTotal?: number;
}

/** Evaluate ordering guards; `block` guards prevent the write, `warn` are advisory. */
export function evaluateGuards(c: GuardContext): Guard[] {
  const g: Guard[] = [];
  const d = c.delivery;
  const o = c.order;
  const pastDeadline = d.pastLateOrderDeadline || o?.pastLateOrderDeadline;

  if (d.isReadOnly) {
    g.push({
      code: "delivery_read_only",
      level: "block",
      message: "This delivery is read-only (locked).",
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
    if (o?.isOverVenueCapacity) {
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
    const noMonthlyLate = c.user?.remainingLateOrdersMonthOf === 0;
    if (pastDeadline) {
      if (o && o.changeRequestAllowed === false) {
        g.push({
          code: "change_request_not_allowed",
          level: "block",
          message:
            "Past the ordering deadline and change requests aren't allowed for this delivery.",
        });
      } else if (
        (o && typeof o.lateOrdersRemaining === "number" && o.lateOrdersRemaining <= 0) ||
        noMonthlyLate
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
    if (pastDeadline) {
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

  if (c.intent === "skip") {
    // Skipping a delivery that already has confirmed/late state is risky; only initial is clearly safe.
    if (d.state && d.state !== "initial" && pastDeadline) {
      g.push({
        code: "delivery_not_initial",
        level: "warn",
        message: `Delivery state is "${d.state}" and past deadline — skipping may not be reversible.`,
      });
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
