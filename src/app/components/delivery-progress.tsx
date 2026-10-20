import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import {
  arrivalTime,
  arrivalRange,
  clockTime,
  fulfillmentLabel,
  trackingUrl,
} from "../lib/delivery-labels.ts";
import { type OpenLink } from "../lib/tools.ts";
import { money } from "@/shared/currency.ts";
import { type Delivery, type DeliveryStatus } from "@/shared/contracts/meals.ts";

export function DeliveryProgress({
  delivery,
  status,
  unavailable,
  loading,
  openLink,
}: {
  delivery: Delivery;
  status?: DeliveryStatus;
  unavailable: boolean;
  loading: boolean;
  openLink?: OpenLink;
}) {
  const [linkError, setLinkError] = useState(false);
  let statusLabel = fulfillmentLabel(status?.fulfillment ?? delivery.fulfillment);
  if (unavailable) statusLabel = "Delivery updates unavailable";
  return (
    <section className="delivery-progress" aria-label="Delivery updates">
      <div className="delivery-summary">
        <span className="status-badge" data-status={delivery.status}>
          {delivery.status === "confirmed" ? "Confirmed" : "Meal selection"}
        </span>
        {loading ? (
          <span role="status" aria-label="Loading delivery updates">
            <span className="skeleton skeleton-status" aria-hidden="true" />
          </span>
        ) : (
          <span>{statusLabel}</span>
        )}
      </div>
      <div className="delivery-meta">
        {!!status?.deliveryWindow?.length && (
          <p className="muted">
            Scheduled window: {status.deliveryWindow.map(clockTime).join("–")} · delivery local time
          </p>
        )}
        {status?.billing.reportedDueCents != null && (
          <p className="muted">Reported due: {money(status.billing.reportedDueCents / 100)}</p>
        )}
      </div>
      {status?.orders.map((order) => {
        const arrived = arrivalTime(order.dropoffCompletedAt, status.timezone);
        const start = arrivalTime(order.etaStart, status.timezone);
        const range = arrivalRange(order.etaStart, order.etaEnd, status.timezone);
        const hasEta = order.fulfillment === "ontime" || order.fulfillment === "delayed";
        const url = trackingUrl(order.trackingUrl);
        if (!arrived && !start && !url && status.orders.length === 1) return null;
        return (
          <div className="order-update" key={order.orderId}>
            <div className="order-update-info">
              <span className="order-venue">
                {order.venue ?? "Restaurant"} · {fulfillmentLabel(order.fulfillment)}
              </span>
              {arrived ? (
                <span className="muted">Delivered at {arrived}</span>
              ) : (
                <>
                  {hasEta && range && (
                    <span
                      className="muted"
                      title={
                        order.fulfillment === "ontime"
                          ? "The ETA will become more precise as the driver approaches your location."
                          : undefined
                      }
                    >
                      {order.fulfillment === "delayed" ? "Delay" : "ETA"} {range}
                    </span>
                  )}
                </>
              )}
            </div>
            {url && (
              <a
                className="btn btn-secondary track-order cursor-interaction"
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={async (event) => {
                  if (!openLink) return;
                  event.preventDefault();
                  try {
                    setLinkError(!!(await openLink(url)).isError);
                  } catch {
                    setLinkError(true);
                  }
                }}
              >
                Track Order
                <ArrowUpRight aria-hidden="true" />
              </a>
            )}
          </div>
        );
      })}
      {linkError && <p role="alert">The host could not open the tracking link.</p>}
    </section>
  );
}
