import { RefreshCw } from "lucide-react";
import { IconButton } from "../icon-button.tsx";
import { dateLabels } from "../../lib/delivery-labels.ts";
import { searchResultsSchema } from "@/shared/contracts/meals.ts";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { defaultFilters, menuView } from "../../lib/menu-filters.ts";
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
import { useMealBrowser } from "../../hooks/use-meal-browser.ts";
import type { CallTool, OpenLink } from "../../lib/tools.ts";

export function MealBrowser({
  call,
  openLink,
  updateContext,
  initial,
  expand,
  displayMode = "inline",
}: {
  call: CallTool;
  openLink?: OpenLink;
  updateContext?: UpdateContext;
  initial?: InitialView;
  expand?: () => Promise<void>;
  displayMode?: McpUiDisplayMode;
}) {
  const [displayError, setDisplayError] = useState<string>();
  const [showBrowser, setShowBrowser] = useState(false);
  const searchLaunch = useMemo(
    () =>
      !!initial?.input.query?.trim() ||
      searchResultsSchema.safeParse(initial?.result.structuredContent).success,
    [initial],
  );
  const compactSearch = displayMode === "inline" && searchLaunch && !showBrowser;
  const browser = useMealBrowser(call, initial);
  const { state } = browser;
  const view = useMemo(
    () =>
      menuView(state.menus, state.recommendations, state.query, state.filters, state.searchMatches),
    [state.menus, state.recommendations, state.query, state.filters, state.searchMatches],
  );
  const contextFailed = useModelContext(
    state,
    view,
    state.deliveriesLoaded && !state.busy ? updateContext : undefined,
  );
  const { delivery, detail, busy, notice, problem } = state;
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const date = delivery ? dateLabels(delivery.date) : undefined;
  function openFullView() {
    setDisplayError(undefined);
    if (expand)
      void expand().catch(() => setDisplayError("Full view is unavailable in this host."));
  }
  function browseAll() {
    browser.setQuery("");
    browser.setFilters(defaultFilters);
    setShowBrowser(true);
    openFullView();
  }
  let emptyMessage = "Unable to load deliveries. Refresh to try again.";
  if (state.deliveriesLoaded) emptyMessage = "No upcoming deliveries.";
  if (busy) emptyMessage = "Loading deliveries…";
  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    browser.choose(menuId, itemId, sourcePieceId);
  }
  return (
    <div aria-busy={busy} className={compactSearch ? "compact-search" : undefined}>
      {compactSearch ? (
        <div className="compact-search-header">
          <div>
            <h2 tabIndex={-1} data-dialog-return-focus>
              Search meals
            </h2>
            {delivery && date && (
              <p className="muted">
                <time dateTime={delivery.date}>
                  {date.weekday}, {date.date}
                </time>
                {delivery.service ? ` · ${delivery.service}` : ""}
              </p>
            )}
          </div>
          <div className="app-toolbar">
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              disabled={busy}
              onClick={browser.refreshSearch}
            />
            <Button disabled={busy} onClick={browseAll}>
              Browse all meals
            </Button>
          </div>
        </div>
      ) : (
        <div className="delivery-toolbar">
          <div className="delivery-heading">
            <h2 tabIndex={-1} data-dialog-return-focus>
              Deliveries
            </h2>
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              disabled={busy}
              onClick={browser.refresh}
            />
          </div>
          <div className="app-toolbar" role="group" aria-label="Meal browser actions">
            {expand && (
              <div className="expand-control">
                <Button disabled={busy} onClick={openFullView}>
                  Open full view
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
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
          {!compactSearch && (
            <DateStrip
              deliveries={state.deliveries}
              selectedId={delivery?.deliveryId}
              busy={busy}
              onSelect={browser.setDelivery}
            />
          )}
          {!compactSearch && delivery && (
            <SelectedMeals
              delivery={delivery}
              menus={state.menus}
              busy={busy}
              choose={choose}
              status={state.deliveryStatus}
            />
          )}
          {!compactSearch && delivery && (
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
            <section className="menu-browser" aria-labelledby="browse-menus-title">
              <h2 id="browse-menus-title" className={compactSearch ? "sr-only" : undefined}>
                {compactSearch ? "Search results" : "Browse menus"}
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
              {!compactSearch && state.recommendationsLoading && (
                <p className="muted" role="status">
                  Loading recommendations…
                </p>
              )}
              {!compactSearch && state.recommendationsUnavailable && (
                <p className="muted" role="status">
                  Recommendations are unavailable. You can still browse all meals.
                </p>
              )}
              <MealCards
                menus={state.menus}
                view={view}
                query={state.query}
                busy={busy}
                choose={choose}
              />
            </section>
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
