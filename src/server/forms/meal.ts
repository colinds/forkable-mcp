import type { OpenAIForm, OpenAIFormResult } from "@openai/mcp-extensions";
import type { Detail } from "@/shared/contracts/meals.ts";
import type { ReplacementTarget } from "@/shared/contracts/preparation.ts";
import { modifierMinimum } from "@/shared/meal-options.ts";
import { formatMoney } from "../order/format.ts";

export function mealForm(detail: Detail, replacements: ReplacementTarget[]): OpenAIForm {
  const required: string[] = [];
  const form: OpenAIForm = { type: "object", properties: {}, required };
  if (replacements.length > 1) {
    form.properties.sourcePieceId = {
      type: "string",
      title: "Meal to replace",
      oneOf: replacements.map((meal) => ({
        const: String(meal.pieceId),
        title: `${meal.name || "Selected meal"} · ${meal.pieceId}`,
      })),
    };
    required.push("sourcePieceId");
  }
  for (const modifier of detail.modifiers) {
    const key = `modifier_${modifier.id}`;
    const min = modifierMinimum(modifier);
    const options = modifier.options.map((option) => ({
      const: String(option.id),
      title: option.name,
      ...(option.price ? { description: `+${formatMoney(option.price)}` } : {}),
    }));
    if (modifier.max === 1) {
      form.properties[key] = {
        type: "string",
        title: modifier.name,
        oneOf: min ? options : [{ const: "", title: "No selection" }, ...options],
      };
    } else {
      form.properties[key] = {
        type: "array",
        title: modifier.name,
        items: { anyOf: options },
        minItems: min,
        ...(modifier.max != null ? { maxItems: modifier.max } : {}),
      };
    }
    if (min) required.push(key);
  }
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
