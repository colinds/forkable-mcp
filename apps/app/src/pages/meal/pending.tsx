import { MealFrame } from "@/app/components/meal/editor/frame.tsx";
import { MealPageLoading } from "@/app/components/meal/editor/page-loading.tsx";

export function MealPending() {
  return (
    <MealFrame>
      <MealPageLoading />
    </MealFrame>
  );
}
