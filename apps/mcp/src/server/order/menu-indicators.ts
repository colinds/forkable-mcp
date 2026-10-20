import { ingredientCategorySchema } from "@forkable-mcp/shared/contracts/meals.ts";
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
    optionalRead(
      client.query<IngredientGroup[]>("ingredients", undefined, "category ingredients"),
      [],
    ),
    date && venueIds.length && !delivery.club?.isDemo
      ? optionalRead(
          client.query<VenueUsage>("venueUsage", { ids: venueIds, from: date, to: date }),
          {},
        )
      : Promise.resolve({} as VenueUsage),
  ]);
  let period: "am" | "pm" | undefined;
  if (typeof delivery.afternoon === "boolean") period = delivery.afternoon ? "pm" : "am";
  const soldOut = new Map<number, boolean>();
  for (const menu of menus) {
    if (delivery.club?.isDemo) {
      soldOut.set(menu.id, false);
      continue;
    }
    const venue = menu.venue;
    if (!venue) continue;
    if (
      delivery.orders?.some((order) => order.venue?.id === venue.id && order.isOverVenueCapacity)
    ) {
      soldOut.set(menu.id, true);
      continue;
    }
    const count = date && period ? usage?.[venue.id]?.[date]?.[period] : undefined;
    if (count !== undefined && Number.isFinite(count) && venue.capacity != null)
      soldOut.set(menu.id, venue.capacity > 0 && count >= venue.capacity);
  }
  return { groups: groups ?? [], soldOut };
}

export function ingredientCategories(tags: string[] | undefined, groups: IngredientGroup[]) {
  if (!tags) return undefined;
  const included = new Set(tags);
  return ingredientCategorySchema.options.filter((category) =>
    groups.some(
      (group) => group.category === category && group.ingredients.some((tag) => included.has(tag)),
    ),
  );
}
