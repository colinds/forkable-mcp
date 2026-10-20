import { useMutation } from "@tanstack/react-query";
import { useParams, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useMealApp } from "@/app/lib/app-context.ts";
import { useEditorContext } from "@/app/lib/editor-context.ts";
import { MEAL_PATH } from "@/app/lib/navigation.ts";
import { MealFrame } from "@/app/components/meal/editor/frame.tsx";
import { MealPhoto } from "@/app/components/meal/photo.tsx";
import { MealSummary } from "@/app/components/meal/editor/summary.tsx";
import { MealDetailLayout } from "@/app/components/meal/editor/layout.tsx";
import { MealNavigation } from "@/app/components/meal/editor/navigation.tsx";
import { Button } from "@/app/components/button.tsx";

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
    <MealDetailLayout
      inline={inline}
      title={browser.state.selectedMeal?.name ?? "Meal details"}
      navigation={
        <MealNavigation backLabel={inline ? backLabel : undefined} onBack={browser.back} />
      }
    >
      {browser.state.selectedMeal ? (
        <MealSummary meal={browser.state.selectedMeal} delivery={browser.state.delivery} />
      ) : (
        <div className="detail-summary">
          <MealPhoto url={null} name="Meal" />
        </div>
      )}
      <div className="detail-content">
        <p className="notice error" role="alert">
          {failure instanceof Error ? failure.message : "Unable to load meal options."}
        </p>
        <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
          Try again
        </Button>
      </div>
    </MealDetailLayout>
  );
  return <MealFrame>{content}</MealFrame>;
}
