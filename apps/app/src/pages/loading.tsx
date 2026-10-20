import { useRouterState } from "@tanstack/react-router";
import { MealPageLoading } from "@/app/components/meal/editor/page-loading.tsx";
import { BrowserLoading } from "@/app/components/browser-loading.tsx";
import { useMealApp } from "@/app/lib/app-context.ts";

export function MealAppLoading() {
  const { queries, displayMode } = useMealApp();
  const view = displayMode === "fullscreen" ? "browse" : queries.launch.view;
  const meal = useRouterState({ select: (state) => state.location.pathname !== "/" });
  return meal ? (
    <div className="meal-page">
      <MealPageLoading />
    </div>
  ) : (
    <BrowserLoading
      view={view}
      showDates={view === "browse" || (view === "delivery" && queries.launch.showDates)}
    />
  );
}
