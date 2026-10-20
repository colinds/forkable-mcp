import { useRouterState } from "@tanstack/react-router";
import { MealPageLoading } from "../components/meal/editor/page-loading.tsx";

export function MealAppLoading() {
  const meal = useRouterState({ select: (state) => state.location.pathname !== "/" });
  return meal ? (
    <div className="meal-page">
      <MealPageLoading />
    </div>
  ) : (
    <p role="status">Loading deliveries…</p>
  );
}
