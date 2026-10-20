import { useEditorContext } from "../../lib/editor-context.ts";
import { useMealEditor } from "../../hooks/use-meal-editor.ts";
import { useModelContext } from "../../hooks/use-model-context.ts";
import { MealFrame } from "../../components/meal/editor/frame.tsx";
import { MealDetail } from "../../components/meal/editor/detail.tsx";
import { useMealApp } from "../../lib/app-context.ts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { MEAL_PATH } from "../../lib/navigation.ts";

export function MealEditorPage() {
  const { browser, inline, backLabel, view, presentation } = useEditorContext();
  const { queries, updateContext } = useMealApp();
  const params = useParams({ from: MEAL_PATH });
  const { data: meal } = useSuspenseQuery(queries.detail(params));
  const editor = useMealEditor(browser, meal);
  const { busy, pendingAction } = editor.state;
  const contextFailed = useModelContext(
    { ...editor.state, presentation },
    inline ? { ...view, ordered: [] } : view,
    browser.state.deliveriesLoaded && !busy ? updateContext : undefined,
  );
  const content = (
    <>
      {contextFailed && (
        <p className="muted" role="status">
          Chat context could not be updated. Try reopening the app.
        </p>
      )}
      <MealDetail browser={editor} backLabel={inline ? backLabel : undefined} />
    </>
  );
  return (
    <MealFrame locked={(busy && pendingAction !== "loading") || editor.state.needsRefresh}>
      {content}
    </MealFrame>
  );
}
