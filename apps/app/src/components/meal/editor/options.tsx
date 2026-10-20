import { MessageSquare } from "lucide-react";
import { modifierMinimum, MEAL_INSTRUCTIONS_LIMIT } from "@forkable-mcp/shared/meal-options.ts";
import { money } from "@forkable-mcp/shared/currency.ts";
import { Button } from "@/app/components/button.tsx";
import type { MealEditorController } from "@/app/hooks/use-meal-browser.ts";
import type { ReactNode } from "react";
import { MealSkipAction } from "./skip-action.tsx";

export function MealOptions({
  browser,
  children,
}: {
  browser: MealEditorController;
  children?: ReactNode;
}) {
  const { state, soldOut } = browser;
  const { busy, delivery, detail: meal } = state;
  if (!delivery) return null;
  const submitLabel = delivery.meals.length ? "Replace meal" : "Add meal";
  return (
    <div className="detail-content">
      {children}
      {state.notice && (
        <p
          className={`notice ${state.problem ? "error" : ""}`}
          role={state.problem ? "alert" : "status"}
        >
          {state.notice}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          browser.submit();
        }}
      >
        {delivery.meals.length === 1 && (
          <p className="muted">Replacing {delivery.meals[0]!.name ?? "your selected meal"}</p>
        )}
        {delivery.meals.length > 1 && (
          <>
            <label htmlFor="source" className="form-label">
              Meal to replace
            </label>
            <select
              id="source"
              className="form-control"
              required
              disabled={busy}
              value={state.source}
              onChange={(event) => browser.setSource(event.currentTarget.value)}
            >
              <option value="">Choose your existing meal</option>
              {delivery.meals.map((target) => (
                <option key={target.pieceId} value={String(target.pieceId)}>
                  {target.name ?? "Meal"}
                  {target.cancellationPending ? " (removal pending)" : ""}
                </option>
              ))}
            </select>
          </>
        )}
        {meal.modifiers.map((mod) => {
          const min = modifierMinimum(mod);
          return (
            <fieldset key={mod.id} disabled={busy}>
              <legend>
                {mod.name} · {min ? `choose at least ${min}` : "optional"}
                {mod.max == null ? "" : `, up to ${mod.max}`}
              </legend>
              {mod.options.map((option) => (
                <label key={option.id} className="option cursor-interaction">
                  <input
                    type="checkbox"
                    checked={state.choices[mod.id]?.includes(option.id) ?? false}
                    onChange={(event) =>
                      browser.chooseOption(mod.id, option.id, event.currentTarget.checked, mod.max)
                    }
                  />
                  <span>
                    {option.name}
                    {option.price ? ` (+${money(option.price)})` : ""}
                  </span>
                </label>
              ))}
            </fieldset>
          );
        })}
        {meal.instructionsAllowed && (
          <div>
            <label className="form-label" htmlFor="meal-notes">
              Notes <span className="muted">(optional)</span>
            </label>
            <textarea
              id="meal-notes"
              className="form-control"
              rows={3}
              maxLength={MEAL_INSTRUCTIONS_LIMIT}
              placeholder="E.g., please no onions"
              disabled={busy}
              value={state.instructions}
              onChange={(event) => browser.setInstructions(event.currentTarget.value)}
            />
            <p className="muted">
              {state.instructions.length}/{MEAL_INSTRUCTIONS_LIMIT}
            </p>
          </div>
        )}
        <footer className="detail-actions">
          <Button
            type="submit"
            primary
            disabled={busy || state.needsRefresh || soldOut}
            aria-describedby={soldOut ? "sold-out-message" : undefined}
          >
            {state.pendingAction === "saving"
              ? "Saving…"
              : `${submitLabel} · ${money(browser.mealTotal)}`}
          </Button>
          {soldOut && (
            <p id="sold-out-message" className="muted" role="status">
              Sold out for this delivery. Please choose another restaurant.
            </p>
          )}
          {browser.askAboutMeal && (
            <Button disabled={busy} onClick={browser.askAboutMeal}>
              <MessageSquare aria-hidden="true" />
              {state.pendingAction === "drafting" ? "Adding to draft…" : "Ask about this meal"}
            </Button>
          )}
          {browser.mealToSkip && <MealSkipAction meal={browser.mealToSkip} />}
        </footer>
      </form>
    </div>
  );
}
