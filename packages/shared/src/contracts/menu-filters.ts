import { z } from "zod";

export const menuFiltersSchema = z.object({
  restaurantId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "A menuId from get_menus identifying the restaurant. Includes all menus with that restaurant name.",
    ),
  diet: z
    .string()
    .default("")
    .describe("Exact dietary label from get_menus, or empty for all labels."),
  maxPrice: z
    .number()
    .nonnegative()
    .optional()
    .describe("Maximum meal price in dollars, before paid options. Zero is a valid limit."),
  recommendedOnly: z.boolean().default(false).describe("Show only Forkable's recommended meals."),
  sort: z.enum(["recommended", "price-low", "price-high"]).default("recommended"),
});

export type MenuFilters = z.infer<typeof menuFiltersSchema>;
