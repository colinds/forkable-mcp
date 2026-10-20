import type { OpenAIForm, OpenAIFormResult } from "@openai/mcp-extensions";
import type { Detail } from "@forkable-mcp/shared/contracts/meals.ts";
import type { ReplacementTarget } from "@forkable-mcp/shared/contracts/preparation.ts";
import { modifierMinimum, MEAL_INSTRUCTIONS_LIMIT } from "@forkable-mcp/shared/meal-options.ts";
import { formatMoney } from "../order/format.ts";

export function mealForm(
  detail: Detail,
  replacements: ReplacementTarget[],
  instructions?: string,
): OpenAIForm {
  const required: string[] = [];
  const form: OpenAIForm = { type: "object", properties: {}, required };
  if (replacements.length > 1) {
    const names = replacements.map((meal) => meal.name?.trim() || "Meal");
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    form.properties.sourcePieceId = {
      type: "string",
      title: "Meal to replace",
      oneOf: replacements.map((meal, index) => ({
        const: String(meal.pieceId),
        title: counts.get(names[index]!)! > 1 ? `${names[index]} (${index + 1})` : names[index]!,
      })),
    };
    required.push("sourcePieceId");
  }
  for (const modifier of detail.modifiers) {
    const key = `modifier_${modifier.id}`;
    const min = modifierMinimum(modifier);
    const options = modifier.options.map((option) => ({
      const: String(option.id),
      title: option.name.trim(),
      ...(option.price
        ? { description: `${option.price > 0 ? "+" : ""}${formatMoney(option.price)}` }
        : {}),
    }));
    if (modifier.max === 1) {
      form.properties[key] = {
        type: "string",
        title: modifier.name.trim(),
        oneOf: min ? options : [{ const: "", title: "None" }, ...options],
      };
    } else {
      form.properties[key] = {
        type: "array",
        title: modifier.name.trim(),
        items: { anyOf: options },
        minItems: min,
        ...(modifier.max != null ? { maxItems: modifier.max } : {}),
      };
    }
    if (min) required.push(key);
  }
  if (detail.instructionsAllowed)
    form.properties.instructions = {
      type: "string",
      title: "Notes",
      maxLength: MEAL_INSTRUCTIONS_LIMIT,
      ...(instructions !== undefined ? { default: instructions } : {}),
    };
  return form;
}

export function mealFormChoices(
  detail: Detail,
  content: Extract<OpenAIFormResult, { action: "accept" }>["content"],
) {
  return detail.modifiers.map((modifier) => {
    const value = content[`modifier_${modifier.id}`];
    let selected: string[] = [];
    if (Array.isArray(value)) selected = value;
    else if (typeof value === "string" && value) selected = [value];
    return {
      modifier: modifier.id,
      options: selected.map((optionId) => Number(optionId)),
    };
  });
}
