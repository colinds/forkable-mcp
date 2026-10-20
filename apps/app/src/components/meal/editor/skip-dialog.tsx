import { Button } from "@/app/components/button.tsx";
import { Dialog } from "@/app/components/dialog.tsx";
import { DeliveryMetadata } from "@/app/components/delivery-metadata.tsx";
import { useEditorContext } from "@/app/lib/editor-context.ts";
import type { Delivery } from "@forkable-mcp/shared/contracts/meals.ts";
import { SkipForward } from "lucide-react";

export function SkipMealDialog({
  meal,
  onClose,
  returnFocus,
}: {
  meal: Delivery["meals"][number];
  onClose: () => void;
  returnFocus?: HTMLElement;
}) {
  const { browser } = useEditorContext();
  const { delivery, busy, notice, problem, needsRefresh } = browser.state;
  if (!delivery) return null;
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
      <DeliveryMetadata date={delivery.date} service={delivery.service} />
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
