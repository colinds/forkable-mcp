import { Button } from "@/app/components/button.tsx";
import { Dialog } from "@/app/components/dialog.tsx";
import { dateLabels } from "@/app/lib/delivery-labels.ts";
import type { MealBrowserController } from "@/app/hooks/use-meal-browser.ts";
import type { Delivery } from "@forkable-mcp/shared/contracts/meals.ts";
import { SkipForward } from "lucide-react";

export function SkipMealDialog({
  browser,
  meal,
  onClose,
  returnFocus,
}: {
  browser: Pick<MealBrowserController, "state" | "skipMeal" | "refresh">;
  meal: Delivery["meals"][number];
  onClose: () => void;
  returnFocus?: HTMLElement;
}) {
  const { delivery, busy, notice, problem, needsRefresh } = browser.state;
  if (!delivery) return null;
  const date = dateLabels(delivery.date);
  return (
    <Dialog
      className="confirmation-dialog"
      label="Skip meal"
      labelledBy="skip-meal-title"
      busy={busy}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <h2 id="skip-meal-title" tabIndex={-1}>
        Skip {meal.name ?? "this meal"}?
      </h2>
      <p className="muted">
        {date.weekday}, {date.date}
        {delivery.service ? ` · ${delivery.service}` : ""}
      </p>
      <p>This removes only this meal from your delivery.</p>
      {notice && problem && (
        <p role="alert" className="notice error">
          {notice}
        </p>
      )}
      <div className="confirmation-actions">
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {needsRefresh ? (
          <Button
            primary
            onClick={() => {
              onClose();
              browser.refresh();
            }}
          >
            Refresh delivery
          </Button>
        ) : (
          <Button
            primary
            disabled={busy}
            onClick={async () => {
              if (await browser.skipMeal(meal.pieceId)) onClose();
            }}
          >
            <SkipForward aria-hidden="true" />
            {busy ? "Skipping…" : "Skip meal"}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
