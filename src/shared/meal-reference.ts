import type { Delivery, Detail } from "./contracts/meals.ts";
import { money } from "./currency.ts";
import { selectedMealModifiers, selectedMealTotal } from "./meal-options.ts";

export interface ForkableReference {
  deliveryId: number;
  menuId?: number;
  itemId?: number;
}

export function referenceUri(ref: ForkableReference): string {
  const delivery = `forkable://delivery/${ref.deliveryId}`;
  return ref.menuId == null || ref.itemId == null
    ? delivery
    : `${delivery}/menu/${ref.menuId}/item/${ref.itemId}`;
}

export function referenceDate(iso?: string, weekday: "short" | "long" = "short"): string {
  const date = new Date(`${iso?.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Upcoming";
  return new Intl.DateTimeFormat("en-US", {
    weekday,
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function mealReferenceTitle(meal: {
  name: string;
  restaurant?: string;
  date: string;
}): string {
  return [meal.name, meal.restaurant, referenceDate(meal.date)].filter(Boolean).join(" · ");
}

export function createMealReference({
  delivery,
  detail,
  restaurant,
  choices = {},
  source,
}: {
  delivery: Delivery;
  detail: Detail;
  restaurant?: string;
  choices?: Record<string, number[]>;
  source?: string;
}) {
  const modifiers = selectedMealModifiers(detail, choices);
  const replacement = delivery.meals.find((meal) => String(meal.pieceId) === source);
  return {
    uri: referenceUri({
      deliveryId: delivery.deliveryId,
      menuId: detail.menuId,
      itemId: detail.itemId,
    }),
    deliveryId: delivery.deliveryId,
    date: delivery.date,
    service: delivery.service ?? undefined,
    club: delivery.club ?? undefined,
    menuId: detail.menuId,
    itemId: detail.itemId,
    name: detail.name,
    restaurant,
    description: detail.description ?? undefined,
    price: detail.price ?? undefined,
    totalPrice: selectedMealTotal(detail, choices),
    modifiers: modifiers.map(({ modifier, options }) => ({
      modifier,
      options: options.map((option) => option.id),
    })),
    selectedOptions: modifiers
      .filter(({ options }) => options.length)
      .map(({ name, options }) => ({ name, options: options.map((option) => option.name) })),
    sourcePieceId: replacement?.pieceId,
    sourceMealName: replacement?.name ?? undefined,
  };
}

export type MealReference = ReturnType<typeof createMealReference>;

export function formatMealReference(meal: MealReference): string {
  const identity = {
    uri: meal.uri,
    deliveryId: meal.deliveryId,
    menuId: meal.menuId,
    itemId: meal.itemId,
    modifiers: meal.modifiers,
    sourcePieceId: meal.sourcePieceId,
  };
  return [
    `${meal.name}${meal.restaurant ? ` — ${meal.restaurant}` : ""}`,
    `Delivery: ${[meal.date, meal.service, meal.club].filter(Boolean).join(" · ")}`,
    meal.description,
    `Selected options: ${meal.selectedOptions.length ? meal.selectedOptions.map((option) => `${option.name}: ${option.options.join(", ")}`).join("; ") : "None selected"}`,
    `Meal price with selected options: ${money(meal.totalPrice)}`,
    meal.sourcePieceId != null
      ? `Meal to replace: ${meal.sourceMealName ?? "Selected meal"}`
      : undefined,
    `Forkable reference: ${JSON.stringify(identity)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
