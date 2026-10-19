import { z } from "zod";
import { setMealInputSchema } from "./inputs.ts";
import { itemDetailSchema } from "./meals.ts";

export const prepareMealInputSchema = setMealInputSchema.pick({
  deliveryId: true,
  menuId: true,
  itemId: true,
  mode: true,
  sourcePieceId: true,
});

const selectionSchema = setMealInputSchema.omit({ confirmToken: true, autoConfirm: true });
const replacementTargetSchema = z.object({
  pieceId: z.union([z.string(), z.number()]),
  name: z.string().optional(),
});

export const prepareMealResultSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("configured"), arguments: selectionSchema }),
  z.object({
    mode: z.literal("needs_input"),
    item: itemDetailSchema.shape.item,
    replacementTargets: z.array(replacementTargetSchema),
  }),
  z.object({ mode: z.literal("cancelled") }),
]);

export type ReplacementTarget = z.infer<typeof replacementTargetSchema>;
