import { useMealApp } from "@/app/lib/app-context.ts";
import { Suspense, useState, useEffect } from "react";
import { MealDraftContext } from "@/app/lib/meal-draft-context.ts";
import type { MealDraftValues } from "@/app/lib/editor-types.ts";
import { useEditorContext } from "@/app/lib/editor-context.ts";
import { MealFrame } from "@/app/components/meal/editor/frame.tsx";
import { MealDetailLayout } from "@/app/components/meal/editor/layout.tsx";
import { MealNavigation } from "@/app/components/meal/editor/navigation.tsx";
import { MealSummary } from "@/app/components/meal/editor/summary.tsx";
import { MealSummaryLoading } from "@/app/components/meal/editor/summary-loading.tsx";
import { MealOptionsLoading } from "@/app/components/meal/editor/options-loading.tsx";
import { MealEditorOptions } from "./options.tsx";

export function MealEditorPage() {
  const { appTools } = useMealApp();
  const [draft, setDraft] = useState<MealDraftValues>();
  const { browser, inline, backLabel } = useEditorContext();
  const { selectedMeal, delivery, busy, pendingAction, needsRefresh } = browser.state;
  const locked = (busy && pendingAction !== "loading") || needsRefresh;
  useEffect(
    () => appTools?.blockNavigation(draft !== undefined || locked),
    [appTools, draft, locked],
  );
  return (
    <MealDraftContext value={{ draft, setDraft }}>
      <MealFrame locked={locked}>
        <MealDetailLayout
          inline={inline}
          title={
            selectedMeal?.name ?? <span className="skeleton skeleton-title" aria-hidden="true" />
          }
          navigation={
            <MealNavigation
              backLabel={inline ? backLabel : undefined}
              disabled={busy && pendingAction !== "loading"}
              onBack={browser.back}
            />
          }
        >
          {selectedMeal ? (
            <MealSummary meal={selectedMeal} delivery={delivery} />
          ) : (
            <MealSummaryLoading />
          )}
          <Suspense fallback={<MealOptionsLoading />}>
            <MealEditorOptions />
          </Suspense>
        </MealDetailLayout>
      </MealFrame>
    </MealDraftContext>
  );
}
