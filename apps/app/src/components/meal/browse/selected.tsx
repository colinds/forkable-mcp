import { MealSkipAction } from "../editor/skip-action.tsx";
import { isPastDelivery } from "@/app/lib/initial-view.ts";
import { MealCard } from "./card.tsx";
import { Button } from "@/app/components/button.tsx";
import type { Delivery, Menu, DeliveryStatus } from "@forkable-mcp/shared/contracts/meals.ts";

export function SelectedMeals({
  delivery,
  menus,
  busy,
  status,
  choose,
  prefetchMeal,
  onBrowseMeals,
}: {
  delivery: Delivery;
  menus: Menu[];
  busy: boolean;
  status?: DeliveryStatus;
  choose: (menuId: number, itemId: number, sourcePieceId?: string | number) => void;
  prefetchMeal: (menuId: number, itemId: number) => Promise<void>;
  onBrowseMeals?: () => void;
}) {
  return (
    <section className="selected-meals" aria-label="Selected meals">
      <div className="selected-heading">
        <h2>{delivery.meals.length === 1 ? "Your meal" : "Your meals"}</h2>
        <p className="muted">{[delivery.service, delivery.club].filter(Boolean).join(" · ")}</p>
      </div>
      {!delivery.meals.length && <p className="muted">No meal selected. Choose one below.</p>}
      <div className="selected-cards">
        {delivery.meals.map((meal) => {
          const mealStatus = status?.meals.find(
            (candidate) => String(candidate.pieceId) === String(meal.pieceId),
          );
          const menu = menus.find((candidate) => candidate.menuId === meal.menuId);
          const item = menu?.items.find((candidate) => candidate.itemId === meal.itemId);
          return (
            <div className="selected-card" key={meal.pieceId}>
              <MealCard
                horizontal
                name={meal.name ?? item?.name ?? "Selected meal"}
                imageUrl={item?.imageUrl ?? null}
                restaurant={mealStatus?.venue ?? menu?.name}
                price={mealStatus?.price}
                description={mealStatus?.options.join(" · ")}
                caption={
                  meal.cancellationPending
                    ? "Removal pending"
                    : ["Selected", mealStatus?.group ? `Group ${mealStatus.group}` : null]
                        .filter(Boolean)
                        .join(" · ")
                }
                disabled={busy}
                onChoose={
                  item && menu ? () => choose(menu.menuId, item.itemId, meal.pieceId) : undefined
                }
                onPrefetch={item && menu ? () => prefetchMeal(menu.menuId, item.itemId) : undefined}
              />
              {!isPastDelivery(delivery.date) && !meal.cancellationPending && (
                <div className="selected-card-actions">
                  <MealSkipAction meal={meal} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {onBrowseMeals && (
        <Button className="selected-action" disabled={busy} onClick={onBrowseMeals}>
          {delivery.meals.length ? "Change meal" : "Choose meal"}
        </Button>
      )}
    </section>
  );
}
