import { type Delivery as PublicDelivery } from "@/shared/contracts/meals.ts";
import { allPieces, ownPieces } from "@/server/order/guards.ts";
import { deliveryStatus, ratingDetails } from "@/server/order/status.ts";
import {
  cancellationPending,
  formatMoney,
  formatDate,
  formatDay,
  formatInstantIn,
  formatInstantLike,
  groupSuffix,
  pieceBadges,
} from "@/server/order/format.ts";
import { type Delivery } from "@/server/order/types.ts";

function fulfillmentSummary(d: Delivery, userId?: number) {
  const status = deliveryStatus(d, userId);
  const tracked =
    status.orders.find((order) => order.fulfillment === "delayed" && order.trackingUrl) ??
    status.orders.find((order) => order.trackingUrl);
  const completed = status.orders
    .filter((order) => order.dropoffCompletedAt)
    .toSorted((a, b) => Date.parse(b.dropoffCompletedAt!) - Date.parse(a.dropoffCompletedAt!))[0];
  return { status, tracked, completed };
}

/** Fulfillment summary for the list line. */
function arrivalNote(d: Delivery, userId?: number): string {
  const { status, tracked, completed } = fulfillmentSummary(d, userId);
  const iana = d.club?.market?.timezone;
  if (status.delayed)
    return `\n    ⚠ DELAYED${tracked?.trackingUrl ? ` — track: ${tracked.trackingUrl}` : ""}`;
  if (status.fulfillment === "delivered") {
    const at =
      (iana
        ? formatInstantIn(
            completed?.dropoffCompletedAt ?? undefined,
            iana,
            completed?.etaShortTz ?? undefined,
          )
        : "") ||
      formatInstantLike(
        completed?.dropoffCompletedAt ?? undefined,
        completed?.etaStart ?? completed?.etaEnd ?? undefined,
        completed?.etaShortTz ?? undefined,
      );
    return `\n    ${at ? `arrived ${at}` : "delivered"}`;
  }
  return status.fulfillment ? `\n    ${status.fulfillment}` : "";
}

/** Member-facing service name. */
export function windowName(d: Delivery): string {
  const n = d.serviceWindow?.name;
  return n === "afternoon" ? "dinner" : (n ?? "");
}

/** Distinguish same-date deliveries by service and club. */
function deliveryTag(d: Delivery): string {
  const bits = [windowName(d), d.club?.name].filter(Boolean);
  return bits.length ? `  ${bits.join(" · ")}` : "";
}

export function fmtDelivery(d: Delivery, inFlight?: Set<number>, userId?: number): string {
  const own = ownPieces(d, userId);
  const others = allPieces(d).length - own.length;
  // Group and state attach to each piece.
  const picked = own.length
    ? own
        .map((p) => `${p.name || `item ${p.itemId}`}${groupSuffix(p.group)}${pieceBadges(p)}`)
        .join(", ")
    : "— nothing selected";
  // Count other members' meals without exposing their details.
  const alsoHere = others > 0 ? `  (+${others} other ${others === 1 ? "meal" : "meals"})` : "";
  // Ordering and fulfillment states are independent.
  const base = d.userConfirmed ? "confirmed" : d.state || "?";
  let status = d.simpleState && d.simpleState !== base ? `${base} · ${d.simpleState}` : base;
  if (inFlight?.has(d.id) && !d.simpleState) status = `${status} · in flight`;
  const due = d.userReceipt?.due;
  const reportedDue = typeof due === "number" ? `  reported due ${formatMoney(due)}` : "";
  return (
    `#${d.id}  ${formatDay(d.forDeliveryAt)}${deliveryTag(d)}  [${status}]${reportedDue}\n` +
    `    ${picked}${alsoHere}${arrivalNote(d, userId)}\n`
  );
}

/** The fields needed to identify a delivery and act on the effective user's meals. */
export function compactDelivery(
  d: Delivery,
  inFlight?: Set<number>,
  userId?: number,
): PublicDelivery {
  const pieces = ownPieces(d, userId);
  const { status: fulfillment, tracked } = fulfillmentSummary(d, userId);
  return {
    deliveryId: d.id,
    date: formatDate(d.forDeliveryAt),
    service: windowName(d) || null,
    club: d.club?.name ?? null,
    status: d.userConfirmed ? "confirmed" : (d.state ?? null),
    fulfillment: fulfillment.fulfillment ?? (inFlight?.has(d.id) ? "in flight" : null),
    needsOrder: pieces.length === 0,
    delayed: fulfillment.delayed,
    trackingUrl: tracked?.trackingUrl ?? null,
    deliveryWindow: d.deliveryWindow ?? null,
    reportedDueCents: fulfillment.billing.reportedDueCents,
    meals: pieces.map((p) => {
      const meal: PublicDelivery["meals"][number] = {
        pieceId: p.id,
        itemId: p.itemId,
        menuId: p.menuId,
        name: p.name,
        group: p.group ?? null,
        isConfirmed: p.isConfirmed ?? null,
        cancellationPending: cancellationPending(p),
        rating: ratingDetails(p.userRating),
      };
      if (p.instructions != null) meal.instructions = p.instructions;
      return meal;
    }),
  };
}
