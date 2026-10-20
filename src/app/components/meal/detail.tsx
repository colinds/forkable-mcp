import { X, MessageSquare } from "lucide-react";
import { IconButton } from "../icon-button.tsx";
import { modifierMinimum, MEAL_INSTRUCTIONS_LIMIT } from "@/shared/meal-options.ts";
import { Button } from "../button.tsx";
import { MealPhoto } from "./photo.tsx";

import { money } from "@/shared/currency.ts";
import type { MealEditorController } from "../../hooks/use-meal-browser.ts";
export function MealDetail({ browser }: { browser: MealEditorController }) {
  const { state } = browser;
  const { busy, delivery, detail } = state;
  if (!delivery || !detail) return null;
  const submitLabel = delivery.meals.length ? "Replace meal" : "Add meal";
  const deliveryLabel = [delivery.date, delivery.service, delivery.club]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="detail" aria-label="Meal details">
      <header className="detail-header">
        <h2 id="meal-title" tabIndex={-1}>
          {detail.name}
        </h2>
        <IconButton icon={X} label="Close" disabled={busy} onClick={browser.back} />
      </header>
      <div className="detail-summary">
        <MealPhoto key={detail.imageUrl} url={detail.imageUrl} name={detail.name} />
        <p className="muted">{deliveryLabel}</p>
        <p className="price">{money(detail.price)}</p>
        {detail.description && <p>{detail.description}</p>}
      </div>
      <div className="detail-content">
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
                {delivery.meals.map((meal) => (
                  <option key={meal.pieceId} value={String(meal.pieceId)}>
                    {meal.name ?? "Meal"}
                    {meal.cancellationPending ? " (removal pending)" : ""}
                  </option>
                ))}
              </select>
            </>
          )}
          {detail.modifiers.map((mod) => {
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
                        browser.chooseOption(
                          mod.id,
                          option.id,
                          event.currentTarget.checked,
                          mod.max,
                        )
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
          {detail.instructionsAllowed && (
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
            <Button type="submit" primary disabled={busy || state.needsRefresh}>
              {state.pendingAction === "saving"
                ? "Saving…"
                : `${submitLabel} · ${money(browser.mealTotal)}`}
            </Button>
            {browser.askAboutMeal && (
              <Button disabled={busy} onClick={browser.askAboutMeal}>
                <MessageSquare aria-hidden="true" />
                {state.pendingAction === "drafting" ? "Adding to draft…" : "Ask about this meal"}
              </Button>
            )}
          </footer>
        </form>
      </div>
    </section>
  );
}
