import { browserInputSchema } from "@/shared/contracts/browser.ts";
import { setMealInputSchema } from "@/shared/contracts/inputs.ts";
import { z } from "zod";

export const MEAL_PATH = "/delivery/$deliveryId/menu/$menuId/item/$itemId";
export const navigationSchema = browserInputSchema.omit({ menuId: true, itemId: true }).extend({
  sourcePieceId: setMealInputSchema.shape.sourcePieceId,
  serverSearch: z.boolean().optional(),
});
export const mealIdentitySchema = setMealInputSchema.pick({
  deliveryId: true,
  menuId: true,
  itemId: true,
});

export function parseMealParams(params: {
  deliveryId: string | number;
  menuId: string | number;
  itemId: string | number;
}) {
  return mealIdentitySchema.parse({
    deliveryId: Number(params.deliveryId),
    menuId: Number(params.menuId),
    itemId: Number(params.itemId),
  });
}
