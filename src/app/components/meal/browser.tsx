import { BrowserToolbar } from "../browser-toolbar.tsx";
import type { BrowserView } from "@/shared/contracts/browser.ts";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { IconButton } from "../icon-button.tsx";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { activeFilterCount, defaultFilters, menuView } from "../../lib/menu-filters.ts";
import { isPastDelivery, type InitialView } from "../../lib/initial-view.ts";
import { useState, useMemo } from "react";
import { Button } from "../button.tsx";
import { DateStrip } from "../date-strip.tsx";
import { MealFilters } from "./filters.tsx";
import { MealCards } from "./grid.tsx";
import { MealDetail } from "./detail.tsx";
import { MealDialog } from "./dialog.tsx";
import { DeliveryProgress } from "../delivery-progress.tsx";
import { SelectedMeals } from "./selected.tsx";
import { useModelContext } from "../../hooks/use-model-context.ts";
import type { UpdateContext } from "../../lib/model-context.ts";
import { useMealBrowser, type MealBrowserHost } from "../../hooks/use-meal-browser.ts";
import type { OpenLink } from "../../lib/tools.ts";

export function MealBrowser({
  host,
  openLink,
  updateContext,
  initial,
  expand,
  displayMode = "inline",
}: {
  host: MealBrowserHost;
  openLink?: OpenLink;
  updateContext?: UpdateContext;
  initial?: InitialView;
  expand?: () => Promise<void>;
  displayMode?: McpUiDisplayMode;
}) {
  const [displayError, setDisplayError] = useState<string>();
  const [viewOverride, setViewOverride] = useState<BrowserView>();
  const browser = useMealBrowser(host, initial);
  const { state } = browser;
  const presentation =
    displayMode === "fullscreen" ? "browse" : (viewOverride ?? browser.launch.view);
  const compact = presentation !== "browse";
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
  const contextFailed = useModelContext(
    { ...state, presentation },
    view,
    state.deliveriesLoaded && !state.busy ? updateContext : undefined,
  );
  const { delivery, detail, busy, notice, problem } = state;
  const [opener, setOpener] = useState<HTMLElement>();
  function openFullView() {
    setDisplayError(undefined);
    if (expand)
      void expand().catch(() => setDisplayError("Full view is unavailable in this host."));
  }
  function browseAll() {
    browser.setQuery("");
    browser.setFilters(defaultFilters);
    setViewOverride("browse");
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
  if (busy) emptyMessage = "Loading deliveries…";
  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    browser.choose(menuId, itemId, sourcePieceId);
  }
  return (
    <div aria-busy={busy} className={compact ? "compact-view" : undefined}>
      <BrowserToolbar
        title={title}
        date={compact ? delivery?.date : undefined}
        service={presentation === "meals" ? (delivery?.service ?? undefined) : undefined}
        busy={busy}
        onRefresh={browser.refresh}
      >
        {presentation === "delivery" && delivery && !isPastDelivery(delivery.date) && (
          <Button disabled={busy} onClick={() => setViewOverride("meals")}>
            Browse meals
          </Button>
        )}
        {presentation === "meals" && (
          <>
            {browser.launch.view === "delivery" && (
              <IconButton
                icon={ArrowLeft}
                label="Back to delivery"
                disabled={busy}
                onClick={() => setViewOverride("delivery")}
              />
            )}
            <Button disabled={busy} onClick={browseAll}>
              Browse all meals
            </Button>
          </>
        )}
        {expand && displayMode !== "fullscreen" && (
          <IconButton
            icon={Maximize2}
            label="Open full view"
            disabled={busy}
            onClick={openFullView}
          />
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
      {notice && !detail && (
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
              status={state.deliveryStatus}
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
                {(!compact || state.filters.recommendedOnly) && state.recommendationsLoading && (
                  <p className="muted" role="status">
                    Loading recommendations…
                  </p>
                )}
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
                  choose={choose}
                />
              </section>
            )
          )}
        </>
      )}
      {detail && delivery && (
        <MealDialog busy={busy} onClose={browser.back} returnFocus={opener}>
          <MealDetail browser={browser} />
        </MealDialog>
      )}
    </div>
  );
}
