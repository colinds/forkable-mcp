import { Check, Clock3, ReceiptText, Store, Truck } from "lucide-react";
import { clockTime, deliveryZoneLabel, fulfillmentLabel } from "@/app/lib/delivery-labels.ts";
import { type OpenLink } from "@/app/lib/tools.ts";
import { money } from "@forkable-mcp/shared/currency.ts";
import { type Delivery, type DeliveryStatus } from "@forkable-mcp/shared/contracts/meals.ts";
import { MetadataItem } from "./metadata-item.tsx";
import { OrderStatus } from "./order-status.tsx";
import { TrackingLink } from "./tracking-link.tsx";

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
  let statusLabel = fulfillmentLabel(status?.fulfillment ?? delivery.fulfillment);
  if (unavailable) statusLabel = "Delivery updates unavailable";
  const deliveryWindow = status?.deliveryWindow;
  const reportedDueCents = status?.billing.reportedDueCents;
  const scheduledZone = deliveryZoneLabel(status?.timezone, status?.date ?? delivery.date);
  const singleOrder = status?.orders.length === 1 ? status.orders[0] : undefined;
  const orderCount = status?.orders.length ?? 0;
  const multipleOrders = orderCount > 1;
  let summary = <MetadataItem icon={Truck}>{statusLabel}</MetadataItem>;
  if (!unavailable && singleOrder)
    summary = <OrderStatus order={singleOrder} timezone={status?.timezone ?? null} />;
  if (!unavailable && multipleOrders)
    summary = <MetadataItem icon={Store}>{orderCount} orders</MetadataItem>;
  return (
    <section className="delivery-progress" aria-label="Delivery updates">
      <div className="delivery-summary">
        <span className="status-badge" data-status={delivery.status}>
          {delivery.status === "confirmed" && <Check size={14} aria-hidden="true" />}
          {delivery.status === "confirmed" ? "Confirmed" : "Meal selection"}
        </span>
        {loading ? (
          <span role="status" aria-label="Loading delivery updates">
            <span className="skeleton skeleton-status" aria-hidden="true" />
          </span>
        ) : (
          summary
        )}
        {singleOrder && (
          <TrackingLink
            key={singleOrder.orderId}
            url={singleOrder.trackingUrl}
            openLink={openLink}
          />
        )}
      </div>
      {(!!deliveryWindow?.length || reportedDueCents != null) && (
        <div className="delivery-meta muted">
          {!!deliveryWindow?.length && (
            <MetadataItem icon={Clock3}>
              <span className="sr-only">Scheduled delivery: </span>
              {deliveryWindow.map(clockTime).join("–")}
              {scheduledZone ? ` ${scheduledZone}` : ""}
            </MetadataItem>
          )}
          {reportedDueCents != null && (
            <MetadataItem icon={ReceiptText}>
              Reported due: {money(reportedDueCents / 100)}
            </MetadataItem>
          )}
        </div>
      )}
      {multipleOrders &&
        status?.orders.map((order) => (
          <div className="order-update" key={order.orderId}>
            <div className="order-update-info">
              <MetadataItem icon={Store}>
                <span className="order-venue">{order.venue ?? "Restaurant"}</span>
              </MetadataItem>
              <OrderStatus order={order} timezone={status.timezone} />
            </div>
            <TrackingLink url={order.trackingUrl} openLink={openLink} />
          </div>
        ))}
    </section>
  );
}
