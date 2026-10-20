import { DateStripLoading } from "./date-strip-loading.tsx";
import { MealCardsLoading } from "@/app/components/meal/browse/loading.tsx";
import { MealCardLoading } from "@/app/components/meal/browse/card-loading.tsx";
import type { BrowserView } from "@forkable-mcp/shared/contracts/browser.ts";

export function BrowserLoading({ view, showDates }: { view: BrowserView; showDates: boolean }) {
  return (
    <section role="status" aria-label="Loading deliveries" aria-busy="true">
      <div className="browser-loading" aria-hidden="true">
        <div className="skeleton skeleton-title" />
        {showDates && <DateStripLoading />}
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
