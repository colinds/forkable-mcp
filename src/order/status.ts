// Fulfillment view of a delivery: where lunch is, when it landed, how to chase it.
// Pure, so the layout is testable without standing up a server.

import { type Delivery } from "./types.ts";
import { deliveryWindow, findOwnMeal, type DeliveryWindow } from "./guards.ts";
import {
  formatDate,
  formatDay,
  formatInstantIn,
  formatInstantLike,
  formatMoney,
} from "./format.ts";

export interface DeliveryStatus {
  id: number;
  date: string;
  day: string;
  /** Fulfillment, not ordering state: "delivered", "en_route", … or "not yet dispatched". */
  fulfillment: string;
  /** `autoOrder` = the member's account orders without per-meal confirmation (mirrors
   *  `user.mealClubAutoOrder`). Not "who picked this dish", so nothing renders it. */
  meal: {
    name: string;
    price: number | null;
    venue: string | null;
    autoOrder: boolean | null;
    /** Pre-rendered customization labels, e.g. "Choose Bread: Dutch Crunch". */
    options: string[];
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
  youPay: number;
  companyLimit: number | null;
  writeWindow: DeliveryWindow;
  ambiguousOwnOrder: boolean;
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

export function deliveryStatus(d: Delivery): DeliveryStatus {
  const own = findOwnMeal(d);
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

  return {
    id: d.id,
    date: formatDate(d.forDeliveryAt),
    day: formatDay(d.forDeliveryAt),
    fulfillment: eta?.status ?? d.simpleState ?? "not yet dispatched",
    meal: (own?.pieces ?? []).map((p) => ({
      name: p.name ?? `item ${p.itemId}`,
      price: p.price ?? null,
      venue: order?.venue?.displayName ?? order?.menu?.name ?? null,
      autoOrder: p.autoOrder ?? null,
      options: (p.nonHiddenAttributes ?? [])
        .map((x) => [x.label, x.value].filter(Boolean).join(": "))
        .filter(Boolean),
    })),
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
    youPay: d.userReceipt?.due ?? 0,
    companyLimit: d.copayAmount ?? null,
    writeWindow: deliveryWindow(d),
    ambiguousOwnOrder: own?.ambiguous === true,
  };
}

/** Every line drops out when its data is absent, so pre- and post-delivery share one renderer. */
export function formatDeliveryStatus(s: DeliveryStatus): string {
  const lines = [`Delivery ${s.id} — ${s.day} — ${s.fulfillment}`];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`  ${label.padEnd(11)}: ${value}`);
  };

  for (const m of s.meal) {
    const bits = [m.name, m.price != null ? formatMoney(m.price) : ""];
    const opts = m.options.length ? ` (${m.options.join(", ")})` : "";
    add("Your meal", `${bits.filter(Boolean).join(" ")}${opts}${m.venue ? ` — ${m.venue}` : ""}`);
  }
  if (!s.meal.length) add("Your meal", "— nothing selected");

  const win = [s.arrivalWindow, s.service ? `(${s.service})` : ""].filter(Boolean).join(" ");
  add("Window", win || null);
  add("Courier ETA", s.etaWindow);
  add("Arrived", s.arrivedAt);
  add("Tracking", s.trackingUrl);
  add("Report by", s.reportMissingItemCutoff);
  // Only worth showing while a change is still possible; after delivery it's noise.
  // The window's note, never a timestamp: editingCutoffAt is a buffet field (see guards.ts).
  if (s.writeWindow.window !== "closed") add("Editing", s.writeWindow.note);
  if (s.youPay !== 0) add("You pay", formatMoney(s.youPay));
  const notes = s.address.notes?.replace(/\s*\n\s*/g, " ");
  add("Access", [s.address.formatted, notes].filter(Boolean).join(" — ") || null);
  if (s.ambiguousOwnOrder)
    lines.push("  (more than one order here has pieces — showing the first)");

  return lines.join("\n");
}
