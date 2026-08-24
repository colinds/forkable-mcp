// Delivery fulfillment projection and rendering.

import { type Delivery, type Order, type Piece } from "./types.ts";
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

export interface OwnedOrderStatus {
  orderId: string | number;
  venue: string | null;
  pieceIds: (string | number)[];
  state: string | null;
  etaStatus: string | null;
  fulfillment: string | null;
  dropoffCompletedAt: string | null;
  etaStart: string | null;
  etaEnd: string | null;
  etaShortTz: string | null;
  trackingUrl: string | null;
}

export interface DeliveryBilling {
  reportedDueCents: number | null;
  allowanceType: string | null;
  copayAmountCents: number | null;
  weeklyAllowanceCents: number | null;
  weeklyAllowanceAvailableCents: number | null;
  memberClubCopayCents: number | null;
}

export interface DeliveryStatus {
  id: number;
  date: string;
  day: string;
  /** Conservative roll-up of positively owned orders. */
  fulfillment: string | null;
  delayed: boolean;
  orders: OwnedOrderStatus[];
  meal: {
    pieceId: string | number;
    orderId: string | number;
    name: string;
    price: number | null;
    venue: string | null;
    autoOrder: boolean | null;
    options: string[];
    group: string | null;
    isConfirmed: boolean | null;
    isLateSwappable: boolean | null;
    cancellationPending: boolean;
    isLateOrder: boolean | null;
  }[];
  /** Scheduled service window as Forkable reported it, not an editing window. */
  deliveryWindow: string[] | null;
  service: string | null;
  timezone: string | null;
  address: { formatted: string | null; notes: string | null };
  reportMissingItemCutoff: string | null;
  reportMissingItemCutoffRaw: string | null;
  replacementCountdown: string | null;
  replacementCutoffRaw: string | null;
  billing: DeliveryBilling;
}

interface OwnedOrder {
  order: Order;
  pieces: Piece[];
}

const serviceName = (name: string): string => (name === "afternoon" ? "dinner" : name);

function clockOf(iso?: string | null): [string, string] | null {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(iso ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  return [`${hour % 12 === 0 ? 12 : hour % 12}:${match[2]}`, hour < 12 ? "AM" : "PM"];
}

function rangeOf(start?: string | null, end?: string | null, tz?: string | null): string | null {
  const first = clockOf(start);
  const last = clockOf(end);
  if (!first || !last) return null;
  const left = first[1] === last[1] ? first[0] : `${first[0]} ${first[1]}`;
  return `${left}–${last[0]} ${last[1]}${tz ? ` ${tz}` : ""}`;
}

function dollarsToCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function positivelyOwnedOrders(d: Delivery, userId?: number): OwnedOrder[] {
  if (userId == null) return [];
  return (d.orders ?? []).flatMap((order) => {
    const pieces = (order.pieces ?? []).filter(
      (piece) => piece.userId != null && piece.userId === userId,
    );
    return pieces.length ? [{ order, pieces }] : [];
  });
}

function fulfillmentFor(order: Order): string | null {
  if (order.dropoffCompletedAt) return "delivered";
  return order.etaStatus?.status ?? order.state ?? null;
}

function aggregateFulfillment(orders: OwnedOrderStatus[], d: Delivery): string | null {
  const statuses = orders.flatMap((order) =>
    order.fulfillment == null ? [] : [order.fulfillment],
  );
  if (orders.length && orders.every((order) => order.fulfillment === "delivered")) {
    return "delivered";
  }
  if (statuses.includes("delivered")) return "partially delivered";
  if (statuses.includes("delayed")) return "delayed";
  const unique = [...new Set(statuses)];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return "mixed";
  return d.simpleState ?? d.state ?? null;
}

function soonestReplacement(
  orders: OwnedOrder[],
  now: Date,
): Pick<DeliveryStatus, "replacementCountdown" | "replacementCutoffRaw"> {
  const all = orders
    .map(({ order }) => order.replacementCutoffTs)
    .filter((timestamp): timestamp is string => !!timestamp)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  const live = all.find((timestamp) => formatCountdown(timestamp, now) !== "");
  return {
    replacementCountdown: live ? formatCountdown(live, now) : null,
    replacementCutoffRaw: live ?? all.at(-1) ?? null,
  };
}

function orderStatus({ order, pieces }: OwnedOrder): OwnedOrderStatus {
  return {
    orderId: order.id,
    venue: order.venue?.displayName ?? order.venue?.name ?? order.menu?.name ?? null,
    pieceIds: pieces.map((piece) => piece.id),
    state: order.state ?? null,
    etaStatus: order.etaStatus?.status ?? null,
    fulfillment: fulfillmentFor(order),
    dropoffCompletedAt: order.dropoffCompletedAt ?? null,
    etaStart: order.etaStatus?.start ?? null,
    etaEnd: order.etaStatus?.end ?? null,
    etaShortTz: order.etaStatus?.shortTz ?? null,
    trackingUrl: order.etaStatus?.trackingUrl ?? null,
  };
}

export function deliveryStatus(
  d: Delivery,
  userId?: number,
  now: Date = new Date(),
): DeliveryStatus {
  const owned = positivelyOwnedOrders(d, userId);
  const orders = owned.map(orderStatus);
  const timezone = d.club?.market?.timezone ?? null;
  const zoneSource = orders.find((order) => order.etaStart)?.etaStart;
  const zoneLabel = orders.find((order) => order.etaShortTz)?.etaShortTz;
  const reportMissingItemCutoff =
    (timezone
      ? formatInstantIn(d.reportMissingItemCutoff, timezone, zoneLabel ?? undefined)
      : "") ||
    formatInstantLike(d.reportMissingItemCutoff, zoneSource ?? undefined, zoneLabel ?? undefined) ||
    null;

  return {
    id: d.id,
    date: formatDate(d.forDeliveryAt),
    day: formatDay(d.forDeliveryAt),
    fulfillment: aggregateFulfillment(orders, d),
    delayed: orders.some((order) => order.fulfillment === "delayed"),
    orders,
    meal: owned.flatMap(({ order, pieces }) =>
      pieces.map((piece) => ({
        pieceId: piece.id,
        orderId: order.id,
        name: piece.name ?? `item ${piece.itemId}`,
        price: piece.price ?? null,
        venue: order.venue?.displayName ?? order.venue?.name ?? order.menu?.name ?? null,
        autoOrder: piece.autoOrder ?? null,
        options: (piece.nonHiddenAttributes ?? [])
          .map((attribute) => [attribute.label, attribute.value].filter(Boolean).join(": "))
          .filter(Boolean),
        group: piece.group ?? null,
        isConfirmed: piece.isConfirmed ?? null,
        isLateSwappable: piece.isLateSwappable ?? null,
        cancellationPending: cancellationPending(piece),
        isLateOrder: piece.isLateOrder ?? null,
      })),
    ),
    deliveryWindow: d.deliveryWindow ? [...d.deliveryWindow] : null,
    service: d.serviceWindow?.name
      ? `${serviceName(d.serviceWindow.name)}${d.serviceWindow.baseTime ? `, base ${d.serviceWindow.baseTime.slice(0, 5)}` : ""}`
      : null,
    timezone,
    address: { formatted: d.address?.formatted ?? null, notes: d.address?.notes ?? null },
    reportMissingItemCutoff,
    reportMissingItemCutoffRaw: d.reportMissingItemCutoff ?? null,
    ...soonestReplacement(owned, now),
    billing: {
      reportedDueCents: dollarsToCents(d.userReceipt?.due),
      allowanceType: d.allowanceType ?? null,
      copayAmountCents: dollarsToCents(d.copayAmount),
      weeklyAllowanceCents: dollarsToCents(d.weeklyAllowance),
      weeklyAllowanceAvailableCents: dollarsToCents(d.weeklyAllowanceAvailable),
      memberClubCopayCents: dollarsToCents(d.userReceipt?.clubCopay),
    },
  };
}

function formatOrderInstant(
  s: DeliveryStatus,
  order: OwnedOrderStatus,
  iso: string | null,
): string | null {
  return (
    (s.timezone
      ? formatInstantIn(iso ?? undefined, s.timezone, order.etaShortTz ?? undefined)
      : "") ||
    formatInstantLike(
      iso ?? undefined,
      order.etaStart ?? undefined,
      order.etaShortTz ?? undefined,
    ) ||
    null
  );
}

/** Omit status lines whose source data is absent. */
export function formatDeliveryStatus(s: DeliveryStatus): string {
  const aggregate = s.fulfillment ?? "status unavailable";
  let headline = aggregate;
  if (s.delayed) headline = aggregate === "delayed" ? "⚠ DELAYED" : `⚠ DELAYED — ${aggregate}`;
  const lines = [`Delivery ${s.id} — ${s.day} — ${headline}`];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`  ${label.padEnd(11)}: ${value}`);
  };

  for (const meal of s.meal) {
    const dish = [meal.name, meal.price != null ? formatMoney(meal.price) : ""]
      .filter(Boolean)
      .join(" ");
    const options = meal.options.length ? ` (${meal.options.join(", ")})` : "";
    const segments = [dish + options, meal.venue].filter(Boolean).join(" — ");
    add("Your meal", segments + groupSuffix(meal.group) + pieceBadges(meal));
  }
  if (!s.meal.length) add("Your meal", "— nothing selected");

  const scheduled = s.deliveryWindow?.length === 2 ? s.deliveryWindow.join("–") : null;
  const window = [scheduled, s.service ? `(${s.service})` : ""].filter(Boolean).join(" ");
  add("Window", window || null);

  const severalOrders = s.orders.length > 1;
  for (const order of s.orders) {
    const context = order.venue
      ? `${order.venue}, order ${order.orderId}`
      : `order ${order.orderId}`;
    const suffix = severalOrders ? ` (${context})` : "";
    if (severalOrders) {
      add(`Order ${order.orderId}`, [order.venue, order.fulfillment].filter(Boolean).join(" — "));
    }
    add(`Courier ETA${suffix}`, rangeOf(order.etaStart, order.etaEnd, order.etaShortTz));
    add(`Arrived${suffix}`, formatOrderInstant(s, order, order.dropoffCompletedAt));
    add(`Tracking${suffix}`, order.trackingUrl);
  }

  add("Report by", s.reportMissingItemCutoff);
  if (s.replacementCountdown) {
    add("Re-pick by", `${s.replacementCountdown} left — the restaurant cancelled`);
  }
  if (s.billing.reportedDueCents != null && s.billing.reportedDueCents !== 0) {
    add("Reported due", formatMoney(s.billing.reportedDueCents / 100));
  }
  const notes = s.address.notes?.replace(/\s*\n\s*/g, " ");
  add("Access", [s.address.formatted, notes].filter(Boolean).join(" — ") || null);
  if (s.meal.some((meal) => meal.isConfirmed === false)) {
    lines.push("  (an unconfirmed meal is not ordered — confirm_delivery to lock it in)");
  }

  return lines.join("\n");
}
