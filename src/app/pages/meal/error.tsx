import { useMutation } from "@tanstack/react-query";
import { useParams, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useMealApp } from "../../lib/app-context.ts";
import { useEditorContext } from "../../lib/editor-context.ts";
import { MEAL_PATH } from "../../lib/navigation.ts";
import { MealFrame } from "../../components/meal/editor/frame.tsx";
import { MealPhoto } from "../../components/meal/photo.tsx";
import { MealNavigation } from "../../components/meal/editor/navigation.tsx";
import { Button } from "../../components/button.tsx";

export function MealRouteError({ error }: ErrorComponentProps) {
  const { browser, inline, backLabel } = useEditorContext();
  const { queries, queryClient } = useMealApp();
  const params = useParams({ from: MEAL_PATH });
  const router = useRouter();
  const retry = useMutation({
    mutationFn: async () => {
      await queryClient.fetchQuery(queries.detail(params));
      await router.invalidate();
    },
  });
  const failure = retry.error ?? error;
  const content = (
    <section className="detail" aria-label="Meal details">
      <header className={`detail-header${inline ? " detail-page-header" : ""}`}>
        {inline && <MealNavigation backLabel={backLabel} onBack={browser.back} />}
        <h2 id="meal-title" tabIndex={-1}>
          {browser.state.selectedMeal?.name ?? "Meal details"}
        </h2>
        {!inline && <MealNavigation onBack={browser.back} />}
      </header>
      <div className="detail-summary">
        <MealPhoto
          url={browser.state.selectedMeal?.imageUrl ?? null}
          name={browser.state.selectedMeal?.name ?? "Meal"}
        />
      </div>
      <div className="detail-content">
        <p className="notice error" role="alert">
          {failure instanceof Error ? failure.message : "Unable to load meal options."}
        </p>
        <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
          Try again
        </Button>
      </div>
    </section>
  );
  return <MealFrame>{content}</MealFrame>;
}
