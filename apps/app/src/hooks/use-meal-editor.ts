import { useMealDraft } from "@/app/lib/meal-draft-context.ts";
import { useSearch } from "@tanstack/react-router";
import { selectedMealTotal } from "@forkable/shared/meal-options.ts";
import { createMealReference } from "@forkable/shared/meal-reference.ts";
import type { MealBrowserController } from "./use-meal-browser.ts";
import type { Detail } from "@forkable/shared/contracts/meals.ts";
import type { MealDraftValues } from "@/app/lib/editor-types.ts";

const noChoices: Record<string, number[]> = {};

export function useMealEditor(browser: MealBrowserController, detail: Detail) {
  const { delivery } = browser.state;
  const { sourcePieceId } = useSearch({ from: "__root__" });
  const { draft: edited, setDraft: setEdited } = useMealDraft();
  const defaultSource =
    sourcePieceId ?? (delivery?.meals.length === 1 ? delivery.meals[0]!.pieceId : "");
  function notesFor(pieceId: string | number) {
    const meal = delivery?.meals.find((candidate) => String(candidate.pieceId) === String(pieceId));
    return detail && meal?.menuId === detail.menuId && meal.itemId === detail.itemId
      ? (meal.instructions ?? "")
      : "";
  }
  const draft = edited ?? {
    source: String(defaultSource),
    choices: noChoices,
    instructions: notesFor(defaultSource),
  };
  function update(next: Partial<MealDraftValues>) {
    browser.clearFeedback();
    setEdited({ ...draft, ...next });
  }
  return {
    state: { ...browser.state, detail, ...draft },
    mealTotal: selectedMealTotal(detail, draft.choices),
    back: browser.back,
    submit: () => browser.submit(draft),
    chooseOption: (modifierId: number, optionId: number, checked: boolean, max: number | null) => {
      const picked = draft.choices[modifierId] ?? [];
      let options = picked.filter((id) => id !== optionId);
      if (checked) options = max === 1 ? [optionId] : [...picked, optionId];
      update({ choices: { ...draft.choices, [modifierId]: options } });
    },
    setInstructions: (instructions: string) => update({ instructions }),
    setSource: (source: string) =>
      update({
        source,
        instructions:
          draft.instructions === notesFor(draft.source) ? notesFor(source) : draft.instructions,
      }),
    askAboutMeal: browser.askAboutMeal
      ? () => {
          if (!delivery || !detail) return;
          browser.askAboutMeal?.(
            createMealReference({
              delivery,
              detail,
              restaurant: browser.state.menus.find((menu) => menu.menuId === detail.menuId)?.name,
              ...draft,
            }),
          );
        }
      : undefined,
  };
}
export type MealEditorController = ReturnType<typeof useMealEditor>;
