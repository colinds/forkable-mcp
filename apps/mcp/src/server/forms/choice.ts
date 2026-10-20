import type { OpenAIForm } from "@openai/mcp-extensions";
import type { MealChoice } from "@forkable-mcp/shared/contracts/preparation.ts";
import { money } from "@forkable-mcp/shared/currency.ts";
import { KEEP_ICON, SKIP_ICON, MEAL_ICON } from "./icons.ts";
import { loadMealThumbnail, type MealThumbnail } from "./thumbnail.ts";

export async function loadMealChoiceForm(
  choices: MealChoice[],
  canKeep: boolean,
  mode: "set" | "add" = "set",
): Promise<OpenAIForm> {
  const thumbnails = new Map<string, MealThumbnail>();
  // Bound inline payload size and download time; additional choices keep their remote photos.
  const sources = [
    ...new Set(choices.flatMap((meal) => (meal.imageUrl ? [meal.imageUrl] : []))),
  ].slice(0, 8);
  await Promise.all(
    sources.map(async (src) => {
      const thumbnail = await loadMealThumbnail(src);
      if (thumbnail) thumbnails.set(src, thumbnail);
    }),
  );
  return mealChoiceForm(choices, canKeep, mode, thumbnails);
}

export function mealChoiceForm(
  choices: MealChoice[],
  canKeep: boolean,
  mode: "set" | "add" = "set",
  thumbnails: ReadonlyMap<string, MealThumbnail> = new Map(),
): OpenAIForm {
  return {
    type: "object",
    required: ["meal"],
    properties: {
      meal: {
        type: "string",
        title: "Meal",
        oneOf: [
          ...(canKeep && mode !== "add"
            ? [{ const: "keep", title: "Keep my current meal", "x-openai-thumbnail": KEEP_ICON }]
            : []),
          ...choices.map((meal) => ({
            const: meal.uri,
            title: meal.name.trim(),
            description: `${meal.restaurant} · ${money(meal.price)}`,
            "x-openai-thumbnail": meal.imageUrl
              ? (thumbnails.get(meal.imageUrl) ?? { src: meal.imageUrl })
              : MEAL_ICON,
          })),
          {
            const: "skip",
            title: mode === "add" ? "No additional meal" : "Skip this delivery",
            "x-openai-thumbnail": SKIP_ICON,
          },
        ],
      },
    },
  };
}
