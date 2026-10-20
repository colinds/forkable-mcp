import { MealDetailLayout } from "./layout.tsx";
import { MealSummaryLoading } from "./summary-loading.tsx";
import { MealOptionsLoading } from "./options-loading.tsx";

export function MealPageLoading() {
  return (
    <MealDetailLayout
      loading
      title={<span className="skeleton skeleton-title" aria-hidden="true" />}
    >
      <MealSummaryLoading />
      <MealOptionsLoading />
    </MealDetailLayout>
  );
}
