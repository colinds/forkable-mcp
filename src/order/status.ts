// Fulfillment view of a delivery: where lunch is, when it landed, how to chase it.
// Pure, so the layout is testable without standing up a server.

import { type Delivery, type Order } from "./types.ts";
import { allowanceFor, deliveryWindow, findOwnMeal, type DeliveryWindow } from "./guards.ts";
import {
  cancellationPending,
  formatDate,
  formatDay,
  formatInstantIn,
  formatCountdown,
  formatInstantLike,
  formatMoney,
  groupSuffix,
  pieceBadges,
} from "./format.ts";

export interface DeliveryStatus {
  id: number;
  date: string;
  day: string;
  /**
   * Fulfillment, not ordering state. `etaStatus.status` is a closed three-value enum —
   * `delayed` | `ontime` | `delivered` — falling back to `simpleState`, then
   * "not yet dispatched" before the courier is assigned.
   */
  fulfillment: string;
  /** The courier is running late. Worth shouting about, so it's a flag and not just a word. */
  delayed: boolean;
  /** `autoOrder` = the member's account orders without per-meal confirmation (mirrors
   *  `user.mealClubAutoOrder`). Not "who picked this dish", so nothing renders it. */
  meal: {
    name: string;
    price: number | null;
    venue: string | null;
    autoOrder: boolean | null;
    /** Pre-rendered customization labels, e.g. "Choose Bread: Dutch Crunch". */
    options: string[];
    /** Dropoff group, e.g. "A1" — "this meal is in Group A1". Null until the delivery is grouped. */
    group: string | null;
    /**
     * Per-meal state, null when Forkable didn't report it — which is NOT the same as false.
     * `isConfirmed: false` means this meal won't be ordered; the rest are affordances.
     */
    isConfirmed: boolean | null;
    isLateSwappable: boolean | null;
    cancellationPending: boolean;
    isLateOrder: boolean | null;
  }[];
  /** The club's scheduled window, "11:45–12:15". Named for arrival, NOT the write window. */
  arrivalWindow: string | null;
  service: string | null; // "lunch, base 12:00"
  etaWindow: string | null; // "11:35–11:50 AM PT" — the courier's own estimate
  arrivedAt: string | null;
  arrivedAtRaw: string | null;
  trackingUrl: string | null;
  address: { formatted: string | null; notes: string | null };
  /** Deadline to report a missing item. Rendered as a clock; the zone is INFERRED, not proven. */
  reportMissingItemCutoff: string | null;
  reportMissingItemCutoffRaw: string | null;
  /**
   * The restaurant cancelled and this meal is being replaced: time left to pick again, as "2h 14m".
   * Null when no replacement is in flight — which was every delivery observed, so the timestamp's
   * zone family is inferred from the app. `replacementCutoffRaw` keeps the wire value.
   */
  replacementCountdown: string | null;
  replacementCutoffRaw: string | null;
  youPay: number;
  companyLimit: number | null;
  /** What `companyLimit` means here — "daily limit", "remaining weekly allowance", … */
  companyLimitLabel: string;
  writeWindow: DeliveryWindow;
  ambiguousOwnOrder: boolean;
  /** The meal was matched by owner. False means it's whoever ordered first — don't call it "yours". */
  attributed: boolean;
}

/** The service window is named "afternoon" on the wire but reads as dinner to a member. */
const serviceName = (name: string): string => (name === "afternoon" ? "dinner" : name);

/** "2026-08-11T11:35:00-07:00" → ["11:35", "AM"], in the offset as sent. */
function clockOf(iso?: string): [string, string] | null {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  return [`${h % 12 === 0 ? 12 : h % 12}:${m[2]}`, h < 12 ? "AM" : "PM"];
}

/** "11:35–11:50 AM PT", collapsing a shared meridiem. */
function rangeOf(start?: string, end?: string, tz?: string): string | null {
  const a = clockOf(start);
  const b = clockOf(end);
  if (!a || !b) return null;
  const left = a[1] === b[1] ? a[0] : `${a[0]} ${a[1]}`;
  return `${left}–${b[0]} ${b[1]}${tz ? ` ${tz}` : ""}`;
}

/**
 * The member's most urgent restaurant cancellation across all the venues they hold, as the pair of
 * status fields. A member can hold meals at several venues, and the one that cancelled needn't be the
 * primary order — the same reason `group` is read per piece.
 */
function soonestReplacement(
  orders: { order: Order }[],
  now: Date,
): Pick<DeliveryStatus, "replacementCountdown" | "replacementCutoffRaw"> {
  // By instant, not lexically: these carry an offset, and "…T20:14:00Z" vs "…T13:30:00-07:00" name
  // the same moment while sorting differently as strings.
  const all = orders
    .map((x) => x.order.replacementCutoffTs)
    .filter((ts): ts is string => !!ts)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  // The soonest window still open is the one to count down; with none open, the LATEST cutoff is
  // still reported raw, so a caller can tell "the re-pick window closed" from "no replacement".
  const live = all.find((ts) => formatCountdown(ts, now) !== "");
  return {
    replacementCountdown: live ? formatCountdown(live, now) : null,
    replacementCutoffRaw: live ?? all.at(-1) ?? null,
  };
}

export function deliveryStatus(
  d: Delivery,
  userId?: number,
  now: Date = new Date(),
): DeliveryStatus {
  // Pass `userId`: without it this is "first order with pieces", so on a delivery carrying anyone
  // else's order their ETA, arrival time and tracking link would render as the member's own.
  const own = findOwnMeal(d, userId);
  const order = own?.order;
  const eta = order?.etaStatus;
  const tz = eta?.shortTz ?? undefined;
  // The club's IANA zone is authoritative and DST-correct. Only clubs that expose none fall back to
  // borrowing an offset off a sibling timestamp.
  const zone = d.club?.market?.timezone;
  const zoneSource = eta?.start ?? eta?.end;
  // `formatInstantIn` returns "" for an unusable zone name, so fall through to the sibling offset
  // rather than dropping the line entirely.
  const at = (iso?: string) =>
    (zone ? formatInstantIn(iso, zone, tz) : "") || formatInstantLike(iso, zoneSource, tz) || null;

  const window = d.deliveryWindow ?? [];
  const allowance = allowanceFor(d);

  return {
    id: d.id,
    date: formatDate(d.forDeliveryAt),
    day: formatDay(d.forDeliveryAt),
    fulfillment: eta?.status ?? d.simpleState ?? "not yet dispatched",
    // Arrival outranks a stale `delayed`: food on the table is not still late, and `arrivalNote` in
    // the list already ranks them that way — the two renderers must not disagree.
    delayed: eta?.status === "delayed" && !order?.dropoffCompletedAt,
    // Every venue the member holds a meal at, not just the primary — they may legitimately have two.
    // The group is read per PIECE, not per delivery: two meals can sit in different groups, which is
    // also how the app reads it for a member (`pieces.map(p => p.group)`).
    meal: (own?.orders ?? []).flatMap((x) =>
      x.pieces.map((p) => ({
        name: p.name ?? `item ${p.itemId}`,
        price: p.price ?? null,
        venue: x.order.venue?.displayName ?? x.order.menu?.name ?? null,
        autoOrder: p.autoOrder ?? null,
        options: (p.nonHiddenAttributes ?? [])
          .map((y) => [y.label, y.value].filter(Boolean).join(": "))
          .filter(Boolean),
        group: p.group ?? null,
        isConfirmed: p.isConfirmed ?? null,
        isLateSwappable: p.isLateSwappable ?? null,
        cancellationPending: cancellationPending(p),
        isLateOrder: p.isLateOrder ?? null,
      })),
    ),
    arrivalWindow: window.length === 2 ? `${window[0]}–${window[1]}` : null,
    service: d.serviceWindow?.name
      ? `${serviceName(d.serviceWindow.name)}${d.serviceWindow.baseTime ? `, base ${d.serviceWindow.baseTime.slice(0, 5)}` : ""}`
      : null,
    etaWindow: rangeOf(eta?.start, eta?.end, tz),
    arrivedAt: at(order?.dropoffCompletedAt),
    arrivedAtRaw: order?.dropoffCompletedAt ?? null,
    trackingUrl: eta?.trackingUrl ?? null,
    address: { formatted: d.address?.formatted ?? null, notes: d.address?.notes ?? null },
    reportMissingItemCutoff: at(d.reportMissingItemCutoff),
    reportMissingItemCutoffRaw: d.reportMissingItemCutoff ?? null,
    // Scanned across EVERY venue the member holds, not just the primary order: `meal` above already
    // spans them, so reading `orders[0]` would render a dish whose restaurant cancelled and say
    // nothing about it. Soonest cutoff wins — that's the one with the least time to act on.
    //
    // Only while there is still time, which is where the app lands too (it flips the delivery to
    // read-only the moment its own timer hits zero). `replacementCutoffRaw` keeps the wire value for
    // a caller that wants to say something about an expired window.
    ...soonestReplacement(own?.orders ?? [], now),
    youPay: d.userReceipt?.due ?? 0,
    companyLimit: allowance.limit,
    companyLimitLabel: allowance.label,
    writeWindow: deliveryWindow(d),
    ambiguousOwnOrder: own?.ambiguous === true,
    attributed: own?.byIdentity === true,
  };
}

/** Every line drops out when its data is absent, so pre- and post-delivery share one renderer. */
export function formatDeliveryStatus(s: DeliveryStatus): string {
  // A late courier is the one status a member needs to notice, so it shouts rather than arriving as
  // the lowercase word "delayed". The tracking line below is what they'll want next.
  const headline = s.delayed ? "⚠ DELAYED" : s.fulfillment;
  const lines = [`Delivery ${s.id} — ${s.day} — ${headline}`];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`  ${label.padEnd(11)}: ${value}`);
  };

  // Only claim the meal when it was matched by owner; otherwise it's just whoever ordered first.
  const label = s.attributed ? "Your meal" : "Meal";
  for (const m of s.meal) {
    const dish = [m.name, m.price != null ? formatMoney(m.price) : ""].filter(Boolean).join(" ");
    const opts = m.options.length ? ` (${m.options.join(", ")})` : "";
    // Em-dash segments, each dropping out when absent. Group and state go through the shared
    // `groupSuffix`/`pieceBadges`, so the delivery list can't drift into different wording.
    const segments = [dish + opts, m.venue].filter(Boolean).join(" — ");
    add(label, segments + groupSuffix(m.group) + pieceBadges(m));
  }
  if (!s.meal.length) add("Your meal", "— nothing selected");

  const win = [s.arrivalWindow, s.service ? `(${s.service})` : ""].filter(Boolean).join(" ");
  add("Window", win || null);
  add("Courier ETA", s.etaWindow);
  add("Arrived", s.arrivedAt);
  add("Tracking", s.trackingUrl);
  add("Report by", s.reportMissingItemCutoff);
  // A restaurant cancellation with a clock on it — the most actionable line here when it applies.
  if (s.replacementCountdown)
    add("Re-pick by", `${s.replacementCountdown} left — the restaurant cancelled`);
  // Only worth showing while a change is still possible; after delivery it's noise.
  // The window's note, never a timestamp: editingCutoffAt is a buffet field (see guards.ts).
  if (s.writeWindow.window !== "closed") add("Editing", s.writeWindow.note);
  if (s.youPay !== 0) add("You pay", formatMoney(s.youPay));
  const notes = s.address.notes?.replace(/\s*\n\s*/g, " ");
  add("Access", [s.address.formatted, notes].filter(Boolean).join(" — ") || null);
  // The badge above stays a terse "not confirmed"; the consequence and the fix belong here, where
  // there's room for them, in the same footnote style as the attribution notes.
  if (s.meal.some((m) => m.isConfirmed === false))
    lines.push("  (an unconfirmed meal is not ordered — confirm_delivery to lock it in)");
  if (!s.attributed && s.meal.length)
    lines.push("  (couldn't tell which meal is yours — showing the first ordered)");
  else if (s.ambiguousOwnOrder) lines.push("  (you have meals at more than one venue today)");

  return lines.join("\n");
}
