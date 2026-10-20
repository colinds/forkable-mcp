import { useMealDraft } from "@/app/lib/meal-draft-context.ts";
import { useSearch } from "@tanstack/react-router";
import { selectedMealTotal } from "@forkable-mcp/shared/meal-options.ts";
import { createMealReference } from "@forkable-mcp/shared/meal-reference.ts";
import type { MealBrowserController } from "./use-meal-browser.ts";
import type { Detail } from "@forkable-mcp/shared/contracts/meals.ts";
import type { MealDraftValues } from "@/app/lib/editor-types.ts";
import { isMenuSoldOut } from "@forkable-mcp/shared/menu-availability.ts";

const noChoices: Record<string, number[]> = {};

export function useMealEditor(browser: MealBrowserController, detail: Detail) {
  const { delivery } = browser.state;
  const { sourcePieceId } = useSearch({ from: "__root__" });
  const { draft: edited, setDraft: setEdited } = useMealDraft();
  const requestedSource = delivery?.meals.find(
    (meal) => String(meal.pieceId) === String(sourcePieceId),
  );
  const defaultSource =
    requestedSource?.pieceId ?? (delivery?.meals.length === 1 ? delivery.meals[0]!.pieceId : "");
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
  const sourceMeal = delivery?.meals.find((meal) => String(meal.pieceId) === draft.source);
  const soldOut = isMenuSoldOut(
    browser.state.menus.find((menu) => menu.menuId === detail.menuId),
    sourceMeal,
  );
  function update(next: Partial<MealDraftValues>) {
    browser.clearFeedback();
    setEdited({ ...draft, ...next });
  }
  const mealToSkip = delivery?.meals.find(
    (meal) =>
      String(meal.pieceId) === draft.source &&
      meal.menuId === detail.menuId &&
      meal.itemId === detail.itemId &&
      !meal.cancellationPending,
  );
  return {
    state: { ...browser.state, detail, ...draft },
    mealTotal: selectedMealTotal(detail, draft.choices),
    back: browser.back,
    mealToSkip,
    soldOut,
    submit: () => {
      if (!soldOut) return browser.submit(draft);
    },
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
