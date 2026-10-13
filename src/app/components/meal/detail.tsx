import { useEffect, useRef } from "react";
import { Button } from "../button.tsx";
import { MealPhoto } from "./photo.tsx";
import { money, type Delivery, type Detail } from "../../lib/model.ts";
import type { MealBrowserController } from "../../hooks/use-meal-browser.ts";
export function MealDetail({
  browser,
  delivery,
  detail,
  onBack,
}: {
  browser: MealBrowserController;
  delivery: Delivery;
  detail: Detail;
  onBack: () => void;
}) {
  const { state } = browser;
  const { busy, preview } = state;
  const deliveryLabel = [delivery.date, delivery.service, delivery.club]
    .filter(Boolean)
    .join(" · ");
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), [detail]);
  return (
    <section className="detail card" aria-label="Meal details">
      <Button disabled={busy} onClick={onBack}>
        Close
      </Button>
      {state.notice && (
        <p
          className={`notice ${state.problem ? "error" : ""}`}
          role={state.problem ? "alert" : "status"}
        >
          {state.notice}
        </p>
      )}
      <MealPhoto key={detail.imageUrl} url={detail.imageUrl} name={detail.name} />
      <h2 id="meal-title" ref={title} tabIndex={-1}>
        {detail.name}
      </h2>
      <p className="muted">{deliveryLabel}</p>
      <p className="price">{money(detail.price)}</p>
      {detail.description && <p>{detail.description}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          browser.review();
        }}
      >
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
          const min = Math.max(mod.required ? 1 : 0, mod.min ?? 0);
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
        <Button type="submit" primary disabled={busy || state.needsRefresh}>
          {busy ? "Working…" : "Review change"}
        </Button>
      </form>
      {preview?.mode === "preview" && browser.hasPreview && (
        <section className="preview" aria-label="Confirm meal change">
          <h3>Review your change</h3>
          <p className="muted">{deliveryLabel}</p>
          <p>{preview.summary}</p>
          <p className="muted">Nothing has been sent yet.</p>
          {preview.warnings?.map((warning, i) => (
            <p key={i}>{warning.message}</p>
          ))}
          <Button primary disabled={busy} onClick={browser.confirm}>
            Confirm change
          </Button>
        </section>
      )}
    </section>
  );
}
