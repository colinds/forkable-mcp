import { z } from "zod";
import { todayLocal } from "../dates.ts";
import { calendarDateSchema } from "./inputs.ts";

export const browserInputSchema = z.object({
  deliveryId: z.number().int().positive().optional(),
  menuId: z.number().int().positive().optional(),
  itemId: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  query: z.string().optional(),
});

export const openBrowserInputSchema = browserInputSchema
  .extend({ from: calendarDateSchema.optional(), to: calendarDateSchema.optional() })
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
