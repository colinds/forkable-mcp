import { withReauth } from "@/shared/contracts/errors.ts";
import { deliveriesSchema, deliveryStatusSchema } from "@/shared/contracts/meals.ts";
import { listDeliveriesInputSchema, deliveryStatusInputSchema } from "@/shared/contracts/inputs.ts";
import { type McpServer } from "@modelcontextprotocol/server";
import { deliveryStatus, formatDeliveryStatus } from "@/server/order/status.ts";

import { appResult, errResult } from "@/server/results.ts";
import { guard, APP_TOOL_META } from "@/server/tools/shared.ts";
import {
  DELIVERY_SEL,
  DELIVERY_DETAIL_SEL,
  dateOffsetLocal,
  deliveryRange,
  inProgressIds,
  loadDeliveries,
  findDelivery,
} from "@/server/order/data.ts";
import { fmtDelivery, compactDelivery } from "@/server/order/delivery.ts";

export function registerDeliveryListTool(server: McpServer): void {
  server.registerTool(
    "list_deliveries",
    {
      _meta: APP_TOOL_META,
      title: "List deliveries",
      description:
        "List deliveries, selected meals, and the IDs used by other tools. Defaults to today through " +
        "21 days out; pass both dates for a past-only range. A date can have multiple service or club deliveries.",
      inputSchema: listDeliveriesInputSchema,
      outputSchema: withReauth(deliveriesSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async (client) => {
        // Validate after defaults so a past `to` without `from` cannot invert the range.
        const w = deliveryRange(args.from, args.to);
        if (w.to < w.from)
          return errResult(
            `Window ends before it starts: ${w.from} → ${w.to}. ` +
              (args.from
                ? "Swap `from` and `to`."
                : "`from` defaults to today — pass an earlier `from` to look at the past."),
          );
        const [{ deliveries, userId }, inFlight] = await Promise.all([
          loadDeliveries(client, args.from, DELIVERY_SEL, args.to),
          inProgressIds(client),
        ]);
        if (!deliveries.length)
          return appResult(deliveriesSchema, `No deliveries between ${w.from} and ${w.to}.`, {
            deliveries: [],
          });
        return appResult(
          deliveriesSchema,
          deliveries.map((d) => fmtDelivery(d, inFlight, userId)).join("\n\n"),
          {
            deliveries: deliveries.map((d) => compactDelivery(d, inFlight, userId)),
          },
        );
      }),
  );
}

export function registerDeliveryStatusTool(server: McpServer): void {
  server.registerTool(
    "get_delivery_status",
    {
      _meta: APP_TOOL_META,
      title: "Get delivery status",
      description:
        "Show meal fulfillment, courier ETA, arrival, and each owned order's tracking link, plus delivery access notes.",
      inputSchema: deliveryStatusInputSchema,
      outputSchema: withReauth(deliveryStatusSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deliveryId, from, to }) =>
      guard(async (client) => {
        // The default includes recent completed deliveries and the forward horizon.
        const since = from ?? dateOffsetLocal(-14);
        if (to && to < since)
          return errResult(
            "Window ends before it starts. Supply both from and to for a historical lookup.",
          );
        const { deliveries: ds, userId } = await loadDeliveries(
          client,
          since,
          DELIVERY_DETAIL_SEL,
          to,
        );
        const d = findDelivery(ds, deliveryId);
        if (!d) {
          const seen = ds.length
            ? `Deliveries since ${since}: ${ds.map((x) => x.id).join(", ")}.`
            : `No deliveries found since ${since}.`;
          return errResult(`Delivery ${deliveryId} not found. ${seen}`);
        }
        const s = deliveryStatus(d, userId);
        return appResult(deliveryStatusSchema, formatDeliveryStatus(s), {
          status: {
            deliveryId: s.id,
            date: s.date,
            fulfillment: s.fulfillment,
            delayed: s.delayed,
            deliveryWindow: s.deliveryWindow,
            timezone: s.timezone,
            meals: s.meal.map((meal) => ({
              pieceId: meal.pieceId,
              orderId: meal.orderId,
              name: meal.name,
              price: meal.price,
              options: meal.options,
              venue: meal.venue,
              group: meal.group,
              isConfirmed: meal.isConfirmed,
              cancellationPending: meal.cancellationPending,
              rating: meal.rating,
            })),
            orders: s.orders.map((order) => ({
              orderId: order.orderId,
              venue: order.venue,
              fulfillment: order.fulfillment,
              etaStart: order.etaStart,
              etaEnd: order.etaEnd,
              dropoffCompletedAt: order.dropoffCompletedAt,
              trackingUrl: order.trackingUrl,
            })),
            billing: s.billing,
          },
        });
      }),
  );
}
