import { isPastDelivery, type InitialView } from "../../lib/initial-view.ts";
import { useRef, useState } from "react";
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
import type { CallTool, OpenLink } from "../../lib/model.ts";

export function MealBrowser({
  call,
  openLink,
  updateContext,
  initial,
  expand,
}: {
  call: CallTool;
  openLink?: OpenLink;
  updateContext?: UpdateContext;
  initial?: InitialView;
  expand?: () => Promise<void>;
}) {
  const [displayError, setDisplayError] = useState<string>();
  const browser = useMealBrowser(call, initial);
  const { state } = browser;
  const contextFailed = useModelContext(state, updateContext);
  const { delivery, detail, busy, notice, problem } = state;
  const opener = useRef<HTMLElement | null>(null);
  let emptyMessage = "Unable to load deliveries. Refresh to try again.";
  if (state.deliveriesLoaded) emptyMessage = "No upcoming deliveries.";
  if (busy) emptyMessage = "Loading deliveries…";
  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    browser.choose(menuId, itemId, sourcePieceId);
  }
  return (
    <div aria-busy={busy}>
      <div className="delivery-toolbar">
        <div className="delivery-heading">
          <h2>Deliveries</h2>
          <Button disabled={busy} onClick={browser.refresh}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        </div>
        <div className="app-toolbar" role="group" aria-label="Meal browser actions">
          {expand && (
            <div className="expand-control">
              <Button
                disabled={busy}
                onClick={() => {
                  void expand().catch(() =>
                    setDisplayError("Full view is unavailable in this host."),
                  );
                }}
              >
                Open full view
              </Button>
            </div>
          )}
        </div>
      </div>
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
          <DateStrip
            deliveries={state.deliveries}
            selectedId={delivery?.deliveryId}
            busy={busy}
            onSelect={browser.setDelivery}
          />
          {delivery && (
            <SelectedMeals
              delivery={delivery}
              menus={state.menus}
              busy={busy}
              choose={choose}
              status={state.deliveryStatus}
            />
          )}
          {delivery && (
            <DeliveryProgress
              key={delivery.deliveryId}
              delivery={delivery}
              status={state.deliveryStatus}
              unavailable={state.statusUnavailable}
              openLink={openLink}
            />
          )}
          {delivery && isPastDelivery(delivery.date) ? (
            <p className="muted">
              Past delivery. Menus and meal changes are available for upcoming deliveries.
            </p>
          ) : (
            <section className="menu-browser" aria-labelledby="browse-menus-title">
              <h2 id="browse-menus-title">Browse menus</h2>
              <MealFilters
                menus={state.menus}
                value={state.filters}
                query={state.query}
                onQueryChange={browser.setQuery}
                busy={busy}
                onChange={browser.setFilters}
                onClear={() => browser.setQuery("")}
              />
              <MealCards
                menus={state.menus}
                recommendations={state.recommendations}
                searchMatches={state.searchMatches}
                query={state.query}
                filters={state.filters}
                busy={busy}
                choose={choose}
              />
            </section>
          )}
        </>
      )}
      {detail && delivery && (
        <MealDialog busy={busy} onClose={browser.back} returnFocus={opener.current}>
          <MealDetail browser={browser} delivery={delivery} detail={detail} onBack={browser.back} />
        </MealDialog>
      )}
    </div>
  );
}
