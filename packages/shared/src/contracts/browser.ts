import { menuFiltersSchema } from "./menu-filters.ts";
import { z } from "zod";
import { todayLocal } from "../dates.ts";
import { calendarDateSchema, recommendMealsInputSchema } from "./inputs.ts";

export const browserViewSchema = z.enum(["browse", "delivery", "meals"]);
export type BrowserView = z.infer<typeof browserViewSchema>;

export const browserInputSchema = z.object({
  deliveryId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Delivery ID from list_deliveries. Always pass the matching delivery when showing meals found by another tool. Omitted: select the earliest delivery in the date range.",
    ),
  menuId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Menu ID from get_menus. To open a specific meal, supply deliveryId, menuId and itemId together; item IDs alone are not unique.",
    ),
  itemId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Item ID within menuId. Supply all three IDs to open this meal's details and options.",
    ),
  from: z.string().optional(),
  to: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe(
      "Search dishes, ingredients and restaurant names within the selected delivery. Can be combined with filters. This does not search across delivery dates.",
    ),
  view: browserViewSchema
    .optional()
    .describe(
      "delivery: show the selected delivery and its meals. meals: show search/filter results immediately. browse: show dates, selected meals and restaurant menus. Omitted: meals for a nonempty query, active filters or an exact item; delivery for deliveryId alone; otherwise browse. Fullscreen always uses the full browser.",
    ),
  limit: recommendMealsInputSchema.shape.limit,
  filters: menuFiltersSchema
    .optional()
    .describe(
      "Combine any meal filters and sort order. Omitted fields use the same defaults as the app.",
    ),
});

export const openBrowserInputSchema = browserInputSchema
  .extend({
    from: calendarDateSchema
      .optional()
      .describe(
        "First available delivery date, YYYY-MM-DD. Bounds the delivery list, not a meal search across dates. Include from and to for a historical range.",
      ),
    to: calendarDateSchema
      .optional()
      .describe(
        "Last available delivery date, YYYY-MM-DD. Search and filters still apply only to the selected delivery.",
      ),
  })
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
