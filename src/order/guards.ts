// Local construction and spend-ceiling checks.

import { type Delivery, type Order, type Piece } from "./types.ts";
import { type SelectionViolation } from "./selections.ts";
import { formatMoney } from "./format.ts";

/** One venue's worth of the member's meal: the order plus the pieces they own on it. */
export interface OwnOrder {
  order: Order;
  pieces: Piece[];
}

export interface OwnMeal {
  /** First order carrying matching pieces. */
  order: Order;
  pieces: Piece[];
  /** All orders carrying matching pieces. */
  orders: OwnOrder[];
  /** Whether matching pieces span several orders. */
  ambiguous: boolean;
  /** Whether matching used a user id. */
  byIdentity: boolean;
}

/** Match pieces across venue orders. Writes must supply `userId` and reject ambiguous matches. */
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

/** Every piece across all venue orders, including guest picks. */
export function allPieces(d: Delivery): Piece[] {
  return (d.orders ?? []).flatMap((o) => o.pieces ?? []);
}

export type GuardCode =
  | "menu_not_available"
  | "selection_invalid"
  | "over_total_ceiling"
  | "price_unknown_for_ceiling"
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
  violations?: SelectionViolation[];
  /** Order total (integer cents, base + add-ons) and an optional hard spend ceiling. */
  totalCents?: number;
  maxTotalCents?: number;
}

/** Build local blockers for selections and the configured spend ceiling. */
export function evaluateGuards(c: GuardContext): Guard[] {
  const g: Guard[] = [];
  for (const v of c.violations ?? []) {
    g.push({
      code: "selection_invalid",
      level: "block",
      message: selectionViolationMessage(v),
      data: { ...v },
    });
  }
  if (c.maxTotalCents != null) {
    const totalKnown = Number.isSafeInteger(c.totalCents) && c.totalCents! >= 0;
    const maxKnown = Number.isSafeInteger(c.maxTotalCents) && c.maxTotalCents >= 0;
    if (!totalKnown || !maxKnown) {
      g.push({
        code: "price_unknown_for_ceiling",
        level: "block",
        message:
          "The order total is unavailable, so the configured spend ceiling cannot be verified.",
        data: { totalCents: c.totalCents, maxTotalCents: c.maxTotalCents },
      });
    } else if (c.totalCents! > c.maxTotalCents) {
      g.push({
        code: "over_total_ceiling",
        level: "block",
        message: `This order totals ${formatMoney(c.totalCents! / 100)}, over the ${formatMoney(c.maxTotalCents / 100)} ceiling (FORKABLE_MAX_TOTAL).`,
        data: { totalCents: c.totalCents, maxTotalCents: c.maxTotalCents },
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
    case "ambiguous_option":
      return `An option name for "${v.label}" matches more than one option.`;
    case "ambiguous_modifier":
      return `"${v.label}" matches more than one modifier on this item.`;
    case "duplicate_option":
      return `The same option was selected more than once for "${v.label}".`;
    case "duplicate_modifier":
      return `"${v.label}" was specified more than once.`;
  }
}
