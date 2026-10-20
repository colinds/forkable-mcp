import { z } from "zod";
import { setMealInputSchema } from "./inputs.ts";
import { itemDetailSchema } from "./meals.ts";

export const mealConfigurationInputSchema = setMealInputSchema.pick({
  deliveryId: true,
  menuId: true,
  itemId: true,
  mode: true,
  sourcePieceId: true,
  instructions: true,
});

export const mealShortlistInputSchema = mealConfigurationInputSchema
  .omit({ menuId: true, itemId: true })
  .extend({
    candidates: z
      .array(mealConfigurationInputSchema.pick({ menuId: true, itemId: true }))
      .min(1)
      .describe("Meal shortlist for food selection. Omit menuId/itemId when supplying candidates."),
  });

export const prepareMealInputSchema = mealConfigurationInputSchema
  .extend({
    menuId: mealConfigurationInputSchema.shape.menuId.optional(),
    itemId: mealConfigurationInputSchema.shape.itemId.optional(),
    candidates: mealShortlistInputSchema.shape.candidates.optional(),
  })
  .superRefine((input, context) => {
    if (input.candidates) {
      if (input.menuId != null || input.itemId != null)
        context.addIssue({
          code: "custom",
          message:
            "Provide candidates to choose food, or menuId and itemId to configure one dish; not both.",
        });
    } else if (input.menuId == null || input.itemId == null)
      context.addIssue({
        code: "custom",
        message:
          "Provide candidates to choose food, or both menuId and itemId to configure a dish.",
      });
  });

export const mealChoiceSchema = itemDetailSchema.shape.item
  .pick({
    menuId: true,
    itemId: true,
    name: true,
    price: true,
    imageUrl: true,
  })
  .extend({ restaurant: z.string(), uri: z.string() });
export type MealChoice = z.infer<typeof mealChoiceSchema>;

export const mealChoiceResultSchema = z.union([
  z.object({ mode: z.literal("selected"), arguments: mealConfigurationInputSchema }),
  z.object({ mode: z.enum(["keep", "skip", "cancelled"]), deliveryId: z.number() }),
  z.object({
    mode: z.literal("needs_input"),
    phase: z.literal("meal"),
    deliveryId: z.number(),
    date: z.string(),
    canKeep: z.boolean(),
    choices: z.array(mealChoiceSchema),
  }),
]);

const selectionSchema = setMealInputSchema.omit({ confirmToken: true, autoConfirm: true });
const replacementTargetSchema = z.object({
  pieceId: z.union([z.string(), z.number()]),
  name: z.string().optional(),
});

const customizationResultSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("configured"), arguments: selectionSchema }),
  z.object({
    mode: z.literal("needs_input"),
    phase: z.literal("options"),
    item: itemDetailSchema.shape.item,
    replacementTargets: z.array(replacementTargetSchema),
  }),
  z.object({ mode: z.literal("cancelled") }),
]);

export const prepareMealResultSchema = z.union([customizationResultSchema, mealChoiceResultSchema]);

export type ReplacementTarget = z.infer<typeof replacementTargetSchema>;
