import { useViewLink } from "@/app/hooks/use-view-link.ts";
import { ViewLink } from "@/app/components/view-link.tsx";
import { useDeepLink } from "@/app/hooks/use-deep-link.ts";
import { BrowserToolbar } from "@/app/components/browser-toolbar.tsx";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "@/app/components/icon-button.tsx";
import { Outlet } from "@tanstack/react-router";
import { useMealApp } from "@/app/lib/app-context.ts";
import { MealEditorContext } from "@/app/lib/editor-context.ts";
import { activeFilterCount, menuView } from "@/app/lib/menu-filters.ts";
import { isPastDelivery } from "@/app/lib/initial-view.ts";
import { useState, useMemo } from "react";
import { Button } from "@/app/components/button.tsx";
import { DateStrip } from "@/app/components/date-strip.tsx";
import { MealFilters } from "@/app/components/meal/browse/filters.tsx";
import { MealCards } from "@/app/components/meal/browse/grid.tsx";
import { DeliveryProgress } from "@/app/components/delivery-progress.tsx";
import { SelectedMeals } from "@/app/components/meal/browse/selected.tsx";
import { useModelContext } from "@/app/hooks/use-model-context.ts";
import { useMealBrowser } from "@/app/hooks/use-meal-browser.ts";

export function MealBrowserPage() {
  const { openLink, updateContext, expand, displayMode = "inline" } = useMealApp();
  const [displayError, setDisplayError] = useState<string>();
  const browser = useMealBrowser();
  const { state } = browser;
  const deepLinkError = useDeepLink(browser);
  const presentation = displayMode === "fullscreen" ? "browse" : browser.view;
  const compact = presentation !== "browse";
  const editing = browser.editing;
  const inlineEditor = displayMode === "inline" && editing;
  const view = useMemo(
    () =>
      menuView({
        menus: state.menus,
        recommendations: state.recommendations,
        query: state.query,
        filters: state.filters,
        searchMatches: state.searchMatches,
        layout: presentation === "meals" ? "results" : undefined,
      }),
    [
      state.menus,
      state.recommendations,
      state.query,
      state.filters,
      state.searchMatches,
      presentation,
    ],
  );
  const viewUrl = useViewLink(state);
  const contextFailed = useModelContext(
    { ...state, presentation, url: viewUrl, source: "", choices: {}, instructions: "" },
    inlineEditor ? { ...view, ordered: [] } : view,
    state.deliveriesLoaded && !state.busy && !editing ? updateContext : undefined,
  );
  const { delivery, detail, busy, notice, problem } = state;
  const [opener, setOpener] = useState<HTMLElement>();
  function openFullView() {
    setDisplayError(undefined);
    if (expand)
      void expand().catch(() => setDisplayError("Full view is unavailable in this host."));
  }
  function browseAll() {
    browser.browse();
    openFullView();
  }
  let title = "Meals";
  if (presentation === "browse") title = "Deliveries";
  else if (presentation === "delivery") title = "Your delivery";
  else if (state.query.trim() || state.searchFromServer) title = "Search meals";
  else if (state.filters.recommendedOnly) title = "Recommended meals";
  else if (activeFilterCount(state.filters)) title = "Filtered meals";
  let emptyMessage = "Unable to load deliveries. Refresh to try again.";
  if (state.deliveriesLoaded) emptyMessage = "No upcoming deliveries.";
  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    browser.choose(menuId, itemId, sourcePieceId);
  }
  return (
    <MealEditorContext
      value={{
        browser,
        inline: displayMode === "inline",
        opener,
        backLabel: presentation === "delivery" ? "Back to delivery" : "Back to meals",
        view,
        presentation,
      }}
    >
      <div aria-busy={busy && !state.selectedMeal} className={compact ? "compact-view" : undefined}>
        {deepLinkError && (
          <p role="alert" className="notice error">
            {deepLinkError}
          </p>
        )}
        <div hidden={inlineEditor}>
          <BrowserToolbar
            title={title}
            date={compact ? delivery?.date : undefined}
            service={presentation === "meals" ? (delivery?.service ?? undefined) : undefined}
            busy={busy}
            onRefresh={browser.refresh}
          >
            <ViewLink />
            {presentation === "meals" && (
              <>
                {browser.launch.view === "delivery" && (
                  <IconButton
                    icon={ArrowLeft}
                    label="Back to delivery"
                    disabled={busy}
                    onClick={() => browser.setView("delivery")}
                  />
                )}
                <Button disabled={busy} onClick={browseAll}>
                  Browse all meals
                </Button>
              </>
            )}
          </BrowserToolbar>
          {displayError && (
            <p role="alert" className="notice">
              {displayError}
            </p>
          )}
          {contextFailed && (
            <p className="muted" role="status">
              Chat context could not be updated. Try reopening the app.
            </p>
          )}
          {notice && !detail && !state.selectedMeal && (
            <p className={`notice ${problem ? "error" : ""}`} role={problem ? "alert" : "status"}>
              {notice}
            </p>
          )}
          {!state.deliveries.length && <p className="empty">{emptyMessage}</p>}
          {!!state.deliveries.length && (
            <>
              {(presentation === "browse" ||
                (presentation === "delivery" && browser.launch.showDates)) && (
                <DateStrip
                  deliveries={state.deliveries}
                  selectedId={delivery?.deliveryId}
                  busy={busy}
                  onSelect={browser.setDelivery}
                />
              )}
              {presentation !== "meals" && delivery && (
                <SelectedMeals
                  delivery={delivery}
                  menus={state.menus}
                  busy={busy}
                  choose={choose}
                  prefetchMeal={browser.prefetchMeal}
                  status={state.deliveryStatus}
                  onBrowseMeals={
                    presentation === "delivery" && !isPastDelivery(delivery.date)
                      ? () => browser.setView("meals")
                      : undefined
                  }
                />
              )}
              {presentation !== "meals" && delivery && (
                <DeliveryProgress
                  key={delivery.deliveryId}
                  delivery={delivery}
                  status={state.deliveryStatus}
                  unavailable={state.statusUnavailable}
                  loading={state.statusLoading}
                  openLink={openLink}
                />
              )}
              {delivery && isPastDelivery(delivery.date) ? (
                <p className="muted">
                  Past delivery. Menus and meal changes are available for upcoming deliveries.
                </p>
              ) : (
                presentation !== "delivery" && (
                  <section className="menu-browser" aria-labelledby="browse-menus-title">
                    <h2 id="browse-menus-title" className={compact ? "sr-only" : undefined}>
                      {compact ? "Meal results" : "Browse menus"}
                    </h2>
                    <MealFilters
                      menus={state.menus}
                      value={state.filters}
                      query={state.query}
                      onQueryChange={browser.setQuery}
                      busy={busy}
                      onChange={browser.setFilters}
                      onClear={() => browser.setQuery("")}
                    />
                    {(!compact || state.filters.recommendedOnly) &&
                      state.recommendationsUnavailable && (
                        <p className="muted" role="status">
                          {state.filters.recommendedOnly
                            ? 'Recommendations are unavailable. Turn off "Recommended only" to browse all meals.'
                            : "Recommendations are unavailable. You can still browse all meals."}
                        </p>
                      )}
                    <MealCards
                      menus={state.menus}
                      view={view}
                      query={state.query}
                      busy={busy || (state.filters.recommendedOnly && state.recommendationsLoading)}
                      loading={state.mealsLoading}
                      choose={choose}
                      prefetchMeal={browser.prefetchMeal}
                    />
                  </section>
                )
              )}
            </>
          )}
        </div>
        <Outlet />
      </div>
    </MealEditorContext>
  );
}
