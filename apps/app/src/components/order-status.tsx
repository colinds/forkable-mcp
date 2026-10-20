import { CheckCheck, Truck } from "lucide-react";
import { arrivalRange, arrivalTime, fulfillmentLabel } from "@/app/lib/delivery-labels.ts";
import type { DeliveryStatus } from "@forkable-mcp/shared/contracts/meals.ts";
import { MetadataItem } from "./metadata-item.tsx";

export function OrderStatus({
  order,
  timezone,
}: {
  order: DeliveryStatus["orders"][number];
  timezone: string | null;
}) {
  const arrived = arrivalTime(order.dropoffCompletedAt, timezone);
  const hasEta = order.fulfillment === "ontime" || order.fulfillment === "delayed";
  const range = hasEta ? arrivalRange(order.etaStart, order.etaEnd, timezone) : null;
  return (
    <MetadataItem icon={arrived ? CheckCheck : Truck}>
      {arrived
        ? `Delivered at ${arrived}`
        : [fulfillmentLabel(order.fulfillment), range].filter(Boolean).join(" · ")}
    </MetadataItem>
  );
}
