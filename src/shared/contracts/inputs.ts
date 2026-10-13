import { z } from "zod";
import { isCalendarDate } from "../dates.ts";

export const calendarDateSchema = z
  .string()
  .refine(isCalendarDate, "must be a real calendar date in YYYY-MM-DD form");

export const listDeliveriesInputSchema = z.object({
  from: calendarDateSchema.optional().describe("Inclusive start (YYYY-MM-DD). Defaults to today."),
  to: calendarDateSchema
    .optional()
    .describe(
      "Inclusive end (YYYY-MM-DD). Defaults to at least 21 days out and cannot precede `from`.",
    ),
});

export const getMenusInputSchema = z.object({
  deliveryId: z.number().int().describe("Delivery id from list_deliveries"),
  itemId: z
    .number()
    .int()
    .optional()
    .describe("If set, return this item's full modifiers/options instead of the compact list"),
  menuId: z
    .number()
    .int()
    .optional()
    .describe("Disambiguate itemId when it appears on more than one menu"),
});

export const searchItemsInputSchema = z.object({
  deliveryId: z.number().int(),
  query: z.string().min(1).describe("Search text, e.g. 'chicken', 'vegan burrito'"),
});

export const recommendMealsInputSchema = z.object({
  deliveryId: z.number().int(),
  limit: z.number().int().min(1).max(25).optional().describe("How many suggestions (default 8)"),
});

export const deliveryStatusInputSchema = z.object({
  deliveryId: z.number().int().describe("Delivery id from list_deliveries"),
  from: calendarDateSchema
    .optional()
    .describe("Start of the search window (YYYY-MM-DD). Defaults to 14 days ago."),
  to: calendarDateSchema
    .optional()
    .describe("Inclusive end (YYYY-MM-DD). Supply both dates for a bounded historical lookup."),
});

export const setMealInputSchema = z.object({
  deliveryId: z.number().int(),
  itemId: z
    .number()
    .int()
    .describe("Menu item id (from get_menus / search_items / recommend_meals)"),
  menuId: z
    .number()
    .int()
    .describe("Menu id paired with itemId by get_menus, search_items, or recommend_meals"),
  mode: z
    .enum(["set", "add"])
    .optional()
    .describe('"set" adds if empty or replaces an owned meal; "add" never replaces'),
  sourcePieceId: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Owned piece id from list_deliveries to replace when you have more than one meal on this delivery",
    ),
  modifiers: z
    .array(
      z.object({
        modifier: z.union([z.number(), z.string()]).describe("modifier id or name"),
        options: z.array(z.union([z.number(), z.string()])).describe("option ids or names"),
      }),
    )
    .optional()
    .describe("Modifier choices, e.g. [{modifier:'Choose Protein', options:['Steak']}]"),
  instructions: z.string().optional(),
  autoConfirm: z.boolean().optional().describe("Also confirm the delivery in the same call"),
  confirmToken: z.string().optional().describe("Token from a prior preview, to actually send"),
});

export type SetMealInput = z.infer<typeof setMealInputSchema>;

export interface BrowserToolInputs {
  list_deliveries: z.infer<typeof listDeliveriesInputSchema>;
  get_menus: z.infer<typeof getMenusInputSchema>;
  recommend_meals: z.infer<typeof recommendMealsInputSchema>;
  get_delivery_status: z.infer<typeof deliveryStatusInputSchema>;
  set_meal: SetMealInput;
}
