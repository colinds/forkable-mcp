import { useState } from "react";
import { SkipForward } from "lucide-react";
import { Button } from "@/app/components/button.tsx";
import type { MealBrowserController } from "@/app/hooks/use-meal-browser.ts";
import type { Delivery } from "@forkable-mcp/shared/contracts/meals.ts";
import { SkipMealDialog } from "./skip-dialog.tsx";

export function MealSkipAction({
  browser,
  meal,
}: {
  browser: Pick<MealBrowserController, "state" | "skipMeal" | "refresh" | "clearFeedback">;
  meal: Delivery["meals"][number];
}) {
  const [opener, setOpener] = useState<HTMLButtonElement>();
  const { busy, needsRefresh } = browser.state;
  return (
    <>
      <Button
        disabled={busy || needsRefresh}
        onClick={(event) => {
          browser.clearFeedback();
          setOpener(event.currentTarget);
        }}
      >
        <SkipForward aria-hidden="true" />
        Skip meal
      </Button>
      {opener && (
        <SkipMealDialog
          browser={browser}
          meal={meal}
          returnFocus={opener}
          onClose={() => setOpener(undefined)}
        />
      )}
    </>
  );
}
