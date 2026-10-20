import type { Detail } from "./contracts/meals.ts";

export const MEAL_INSTRUCTIONS_LIMIT = 100;

export function modifierMinimum(modifier: Pick<Detail["modifiers"][number], "required" | "min">) {
  return Math.max(modifier.required ? 1 : 0, modifier.min ?? 0);
}

export function selectedMealModifiers(detail: Detail, choices: Record<string, number[]>) {
  return detail.modifiers.map((modifier) => ({
    modifier: modifier.id,
    name: modifier.name,
    options: modifier.options.filter((option) => choices[modifier.id]?.includes(option.id)),
  }));
}

export function selectedMealTotal(
  detail: Detail,
  choices: Record<string, number[]>,
): number | undefined {
  if (detail.price == null || !Number.isFinite(detail.price)) return undefined;
  let total = detail.price;
  for (const modifier of selectedMealModifiers(detail, choices)) {
    for (const option of modifier.options) total += option.price;
  }
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : undefined;
}
