import { useState } from "react";
import { SkipForward } from "lucide-react";
import { Button } from "@/app/components/button.tsx";
import type { MealEditorController } from "@/app/hooks/use-meal-editor.ts";
import { SkipMealDialog } from "./skip-dialog.tsx";

export function MealSkipAction({ browser }: { browser: MealEditorController }) {
  const [opener, setOpener] = useState<HTMLButtonElement>();
  const { delivery, detail, source, busy, needsRefresh } = browser.state;
  const meal = delivery?.meals.find(
    (candidate) =>
      String(candidate.pieceId) === source &&
      candidate.menuId === detail.menuId &&
      candidate.itemId === detail.itemId,
  );
  if (!meal || meal.cancellationPending) return null;
  return (
    <>
      <Button
        disabled={busy || needsRefresh}
        onClick={(event) => {
          browser.clearFeedback();
          setOpener(event.currentTarget);
        }}
      >
        <SkipForward aria-hidden="true" />
        Skip meal
      </Button>
      {opener && (
        <SkipMealDialog
          browser={browser}
          meal={meal}
          returnFocus={opener}
          onClose={() => setOpener(undefined)}
        />
      )}
    </>
  );
}
