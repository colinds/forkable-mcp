import { z } from "zod";

// Validate at the MCP boundary and infer view types from the same contracts.
const mealSchema = z.object({
  pieceId: z.union([z.string(), z.number()]),
  menuId: z.number().int(),
  itemId: z.number().int(),
  name: z.string().optional(),
  cancellationPending: z.boolean(),
});
const deliverySchema = z.object({
  deliveryId: z.number().int(),
  date: z.string(),
  service: z.string().nullable(),
  club: z.string().nullable(),
  status: z.string().nullable(),
  fulfillment: z.string().nullable(),
  meals: z.array(mealSchema),
});
const itemSchema = z.object({
  itemId: z.number().int(),
  name: z.string(),
  price: z.number().nullable(),
  imageUrl: z.string().nullable(),
  diet: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
const menuSchema = z.object({
  menuId: z.number().int(),
  name: z.string(),
  items: z.array(itemSchema),
});
const modifierSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  required: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  options: z.array(z.object({ id: z.number().int(), name: z.string(), price: z.number() })),
});
const detailSchema = itemSchema.extend({
  menuId: z.number().int(),
  description: z.string().nullable(),
  modifiers: z.array(modifierSchema),
});
const recommendationSchema = z.object({
  menuId: z.number().int(),
  itemId: z.number().int(),
  rank: z.number().int().positive(),
});
export const deliveriesSchema = z.object({ deliveries: z.array(deliverySchema) });
export const menusSchema = z.object({ menus: z.array(menuSchema) });
export const itemDetailSchema = z.object({ item: detailSchema });
export const searchResultsSchema = z.object({
  items: z.array(z.object({ menuId: z.number().int(), itemId: z.number().int() })),
});
export type SearchMatch = z.infer<typeof searchResultsSchema>["items"][number];
export const recommendationsSchema = z.object({ recommendations: z.array(recommendationSchema) });
export type Delivery = z.infer<typeof deliverySchema>;
export type Menu = z.infer<typeof menuSchema>;
export type Detail = z.infer<typeof detailSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export const deliveryStatusSchema = z.object({
  status: z.object({
    deliveryId: z.number().int(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fulfillment: z.string().nullable(),
    delayed: z.boolean(),
    deliveryWindow: z.array(z.string()).nullable(),
    timezone: z.string().nullable(),
    meals: z.array(
      z.object({
        pieceId: z.union([z.string(), z.number()]),
        orderId: z.union([z.string(), z.number()]),
        price: z.number().nullable(),
        venue: z.string().nullable(),
        options: z.array(z.string()),
        group: z.string().nullable(),
        isConfirmed: z.boolean().nullable(),
      }),
    ),
    orders: z.array(
      z.object({
        orderId: z.union([z.string(), z.number()]),
        venue: z.string().nullable(),
        fulfillment: z.string().nullable(),
        etaStart: z.string().nullable(),
        etaEnd: z.string().nullable(),
        dropoffCompletedAt: z.string().nullable(),
        trackingUrl: z.string().nullable(),
      }),
    ),
    billing: z.object({ reportedDueCents: z.number().nullable() }),
  }),
});
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>["status"];
export type OpenLink = (url: string) => Promise<{ isError?: boolean }>;
export const money = (amount: number | null) =>
  amount == null
    ? "Price unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

export interface ToolResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}
export type BrowserToolName =
  | "list_deliveries"
  | "get_menus"
  | "recommend_meals"
  | "get_delivery_status"
  | "set_meal";
export type CallTool = (
  name: BrowserToolName,
  args: Record<string, unknown>,
) => Promise<ToolResult>;
export const IMAGE_ORIGINS = ["https://cdn.filestackcontent.com"];
export function imageUrl(value: string | null): string | undefined {
  try {
    const url = new URL(value ?? "");
    return IMAGE_ORIGINS.includes(url.origin) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export const itemKey = (menuId: number, itemId: number) => `${menuId}:${itemId}`;
const textContentSchema = z.object({ type: z.literal("text"), text: z.string() });
export function resultText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .flatMap((entry: unknown) => {
      const parsed = textContentSchema.safeParse(entry);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("\n");
}
export function data<T>(result: ToolResult, schema: z.ZodType<T>): T {
  if (result.isError)
    throw new Error(resultText(result) || "Forkable could not complete this request.");
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success)
    throw new Error("Forkable returned an unexpected response. Refresh to try again.");
  return parsed.data;
}
export function selectionArgs(
  delivery: Delivery,
  detail: Detail,
  source: string,
  choices: Record<string, number[]>,
): Record<string, unknown> {
  const target = delivery.meals.find((m) => String(m.pieceId) === source);
  if (delivery.meals.length && !target) throw new Error("Choose the meal to replace.");
  for (const mod of detail.modifiers) {
    const count = choices[mod.id]?.length ?? 0;
    const min = Math.max(mod.required ? 1 : 0, mod.min ?? 0);
    if (count < min || (mod.max != null && count > mod.max))
      throw new Error(
        `Choose ${min}${mod.max == null ? " or more" : `–${mod.max}`} options for ${mod.name}.`,
      );
  }
  return {
    deliveryId: delivery.deliveryId,
    menuId: detail.menuId,
    itemId: detail.itemId,
    mode: "set",
    ...(target ? { sourcePieceId: target.pieceId } : {}),
    modifiers: detail.modifiers.map((mod) => ({
      modifier: mod.id,
      options: choices[mod.id] ?? [],
    })),
  };
}
const previewSchema = z.object({
  mode: z.literal("preview"),
  summary: z.string(),
  confirmToken: z.string().min(1),
  expiresAt: z.string(),
  warnings: z.array(z.object({ message: z.string() })).optional(),
});
const writeResultSchema = z.union([
  previewSchema,
  z.object({ mode: z.enum(["executed", "blocked", "rejected", "outcome_unknown"]) }),
]);
export type WriteResult = z.infer<typeof writeResultSchema>;
export function writeResult(result: ToolResult): WriteResult | undefined {
  const parsed = writeResultSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}
/** A preview authorizes only these exact arguments. Consume it before sending, even on transport failure. */
export class Confirmation {
  pending?: { args: Record<string, unknown>; token: string; expiresAt: number };
  clear() {
    this.pending = undefined;
  }
  async preview(call: CallTool, args: Record<string, unknown>): Promise<ToolResult> {
    this.clear();
    const result = await call("set_meal", args);
    const value = writeResult(result);
    if (!result.isError && value?.mode === "preview" && value.confirmToken && value.expiresAt)
      this.pending = {
        args: structuredClone(args),
        token: value.confirmToken,
        expiresAt: Date.parse(value.expiresAt),
      };
    return result;
  }
  async confirm(call: CallTool): Promise<ToolResult> {
    const pending = this.pending;
    this.clear();
    if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now())
      throw new Error("This preview expired. Review the meal again before confirming.");
    return call("set_meal", { ...pending.args, confirmToken: pending.token });
  }
}
