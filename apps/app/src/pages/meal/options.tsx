import { useViewLink } from "@/app/hooks/use-view-link.ts";
import { useEditorContext } from "@/app/lib/editor-context.ts";
import { useMealEditor } from "@/app/hooks/use-meal-editor.ts";
import { useModelContext } from "@/app/hooks/use-model-context.ts";
import { MealOptions } from "@/app/components/meal/editor/options.tsx";
import { useMealApp } from "@/app/lib/app-context.ts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { MEAL_PATH } from "@/app/lib/navigation.ts";

export function MealEditorOptions() {
  const { browser, inline, view, presentation } = useEditorContext();
  const { queries, updateContext } = useMealApp();
  const params = useParams({ from: MEAL_PATH });
  const { data: meal } = useSuspenseQuery(queries.detail(params));
  const editor = useMealEditor(browser, meal);
  const { busy } = editor.state;
  const viewUrl = useViewLink(browser.state);
  const contextFailed = useModelContext(
    { ...editor.state, presentation, url: viewUrl },
    inline ? { ...view, ordered: [] } : view,
    browser.state.deliveriesLoaded && !busy ? updateContext : undefined,
  );
  return (
    <MealOptions browser={editor}>
      {contextFailed && (
        <p className="muted" role="status">
          Chat context could not be updated. Try reopening the app.
        </p>
      )}
    </MealOptions>
  );
}
