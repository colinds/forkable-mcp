import { z } from "zod";
import { isCalendarDate, todayLocal } from "../../order/dates.ts";
import {
  deliveriesSchema,
  searchResultsSchema,
  menusSchema,
  itemDetailSchema,
  recommendationsSchema,
  deliveryStatusSchema,
  type ToolResult,
} from "./model.ts";

export const browserInputSchema = z.object({
  deliveryId: z.number().int().positive().optional(),
  menuId: z.number().int().positive().optional(),
  itemId: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  query: z.string().optional(),
});
const calendarDate = z
  .string()
  .refine(isCalendarDate, "must be a real calendar date in YYYY-MM-DD form");
export const openBrowserInputSchema = browserInputSchema
  .extend({ from: calendarDate.optional(), to: calendarDate.optional() })
  .superRefine((input, context) => {
    if (input.to && (input.from ?? todayLocal()) > input.to)
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Window ends before it starts. Supply from and to for a historical range.",
      });
    if (input.menuId == null && input.itemId == null) return;
    for (const field of ["deliveryId", "menuId", "itemId"] as const) {
      if (input[field] == null)
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Showing an exact meal requires deliveryId, menuId and itemId together.",
        });
    }
  });
export interface InitialView {
  input: z.infer<typeof browserInputSchema>;
  result: ToolResult;
}
export function initialData(view?: InitialView) {
  const result = view?.result.structuredContent;
  return {
    deliveries: deliveriesSchema.safeParse(result).data?.deliveries,
    menus: menusSchema.safeParse(result).data?.menus,
    item: itemDetailSchema.safeParse(result).data?.item,
    recommendations: recommendationsSchema.safeParse(result).data?.recommendations,
    status: deliveryStatusSchema.safeParse(result).data?.status,
    searchItems: searchResultsSchema.safeParse(result).data?.items,
  };
}

export const isPastDelivery = (date: string, today = todayLocal()) => date < today;
export function initialRange(
  view?: InitialView,
  today = todayLocal(),
): { from?: string; to?: string } {
  const input = view?.input;
  const date = deliveryStatusSchema.safeParse(view?.result.structuredContent).data?.status?.date;
  if (date && isPastDelivery(date, today)) return { from: date, to: date };
  return { ...(input?.from ? { from: input.from } : {}), ...(input?.to ? { to: input.to } : {}) };
}
