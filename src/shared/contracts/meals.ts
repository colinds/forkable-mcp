import { z } from "zod";

export const ratingSchema = z.object({
  level: z.number().nullable(),
  reasons: z.array(z.string()),
  comment: z.string().nullable(),
  forGuest: z.boolean().nullable(),
  allowRatingFollowUps: z.boolean().nullable(),
});

export const billingSchema = z.object({
  reportedDueCents: z.number().nullable(),
  allowanceType: z.string().nullable().optional(),
  copayAmountCents: z.number().nullable().optional(),
  weeklyAllowanceCents: z.number().nullable().optional(),
  weeklyAllowanceAvailableCents: z.number().nullable().optional(),
  memberClubCopayCents: z.number().nullable().optional(),
});

const mealSchema = z.object({
  pieceId: z.union([z.string(), z.number()]),
  menuId: z.number().int(),
  itemId: z.number().int(),
  name: z.string().nullable().optional(),
  cancellationPending: z.boolean(),
  group: z.string().nullable().optional(),
  isConfirmed: z.boolean().nullable().optional(),
  rating: ratingSchema.nullable().optional(),
});

const deliverySchema = z.object({
  deliveryId: z.number().int(),
  date: z.string(),
  service: z.string().nullable(),
  club: z.string().nullable(),
  status: z.string().nullable(),
  fulfillment: z.string().nullable(),
  meals: z.array(mealSchema),
  needsOrder: z.boolean().optional(),
  delayed: z.boolean().optional(),
  trackingUrl: z.string().nullable().optional(),
  deliveryWindow: z.array(z.string()).nullable().optional(),
  reportedDueCents: z.number().nullable().optional(),
});

const itemSchema = z.object({
  itemId: z.number().int(),
  name: z.string(),
  price: z.number().nullable(),
  imageUrl: z.string().nullable(),
  diet: z.string().nullable().optional(),
  hasModifiers: z.boolean().optional(),
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
  name: z.string().optional(),
  price: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});

export const deliveriesSchema = z.object({ deliveries: z.array(deliverySchema) });

export const menusSchema = z.object({ menus: z.array(menuSchema) });

export const itemDetailSchema = z.object({ item: detailSchema });

export const searchResultsSchema = z.object({
  items: z.array(
    z.object({
      menuId: z.number().int(),
      itemId: z.number().int(),
      name: z.string().nullable().optional(),
      price: z.number().nullable().optional(),
      imageUrl: z.string().nullable().optional(),
    }),
  ),
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
    date: z.string(),
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
        name: z.string().optional(),
        cancellationPending: z.boolean().optional(),
        rating: ratingSchema.nullable().optional(),
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
    billing: billingSchema,
  }),
});

export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>["status"];

export const getMenusResultSchema = z
  .object({
    menus: menusSchema.shape.menus.optional(),
    item: itemDetailSchema.shape.item.optional(),
  })
  .refine(
    (result) => result.menus !== undefined || result.item !== undefined,
    "Expected menus or an item",
  );
