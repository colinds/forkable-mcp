import { MealCardsLoading } from "./meal/browse/loading.tsx";
import { MealCardLoading } from "./meal/browse/card-loading.tsx";
import type { BrowserView } from "@/shared/contracts/browser.ts";

export function BrowserLoading({ view, showDates }: { view: BrowserView; showDates: boolean }) {
  return (
    <section role="status" aria-label="Loading deliveries" aria-busy="true">
      <div className="browser-loading" aria-hidden="true">
        <div className="skeleton skeleton-title" />
        {showDates && (
          <div className="date-strip">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="date-chip" key={index}>
                <div className="skeleton skeleton-label" />
                <div className="skeleton skeleton-back" />
                <div className="skeleton skeleton-label" />
              </div>
            ))}
          </div>
        )}
        {view !== "meals" && (
          <>
            <div className="skeleton skeleton-title" />
            <MealCardLoading horizontal />
            <div className="skeleton skeleton-label" />
          </>
        )}
        {view !== "delivery" && <div className="skeleton skeleton-control" />}
      </div>
      {view !== "delivery" && <MealCardsLoading />}
    </section>
  );
}
