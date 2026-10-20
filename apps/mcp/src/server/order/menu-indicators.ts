import {
  ingredientCategorySchema,
  type menuCapacitySchema,
} from "@forkable-mcp/shared/contracts/meals.ts";
import type { z } from "zod";
import type { ForkableClient } from "../net/client.ts";
import { ReauthRequiredError } from "../net/errors.ts";
import type { Delivery, Menu } from "./types.ts";

export interface IngredientGroup {
  category: string;
  ingredients: string[];
}

type VenueUsage = Record<string, Record<string, { am?: number; pm?: number }>>;

async function optionalRead<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    return fallback;
  }
}

export async function loadMenuIndicators(
  client: Pick<ForkableClient, "query">,
  delivery: Delivery,
  menus: Menu[],
) {
  const date = delivery.forDeliveryAt?.slice(0, 10);
  const venueIds = [...new Set(menus.flatMap((menu) => (menu.venue ? [menu.venue.id] : [])))];
  const [groups, usage] = await Promise.all([
    optionalRead<IngredientGroup[] | undefined>(
      client.query<IngredientGroup[]>("ingredients", undefined, "category ingredients"),
      undefined,
    ),
    date && venueIds.length && !delivery.club?.isDemo && (delivery.orders?.length ?? 0) > 2
      ? optionalRead(
          client.query<VenueUsage>("venueUsage", { ids: venueIds, from: date, to: date }),
          {},
        )
      : Promise.resolve({} as VenueUsage),
  ]);
  let period: "am" | "pm" | undefined;
  if (typeof delivery.afternoon === "boolean") period = delivery.afternoon ? "pm" : "am";
  const capacity = new Map<number, z.infer<typeof menuCapacitySchema>>();
  for (const menu of menus) {
    if (delivery.club?.isDemo) {
      capacity.set(menu.id, "available");
      continue;
    }
    const venue = menu.venue;
    if (!venue) continue;
    if (
      delivery.orders?.some((order) => order.venue?.id === venue.id && order.isOverVenueCapacity)
    ) {
      capacity.set(menu.id, "over_capacity");
      continue;
    }
    const count = date && period ? usage?.[venue.id]?.[date]?.[period] : undefined;
    if (count !== undefined && Number.isFinite(count) && venue.capacity != null)
      capacity.set(
        menu.id,
        venue.capacity > 0 && count >= venue.capacity ? "at_capacity" : "available",
      );
  }
  return { groups: groups ?? undefined, capacity };
}

export function ingredientCategories(
  tags: string[] | undefined,
  groups: IngredientGroup[] | undefined,
) {
  if (!tags || !groups) return undefined;
  const included = new Set(tags);
  return ingredientCategorySchema.options.filter((category) =>
    groups.some(
      (group) => group.category === category && group.ingredients.some((tag) => included.has(tag)),
    ),
  );
}
