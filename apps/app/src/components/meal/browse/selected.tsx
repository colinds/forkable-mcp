import { MealSkipAction } from "../editor/skip-action.tsx";
import { isPastDelivery } from "@/app/lib/initial-view.ts";
import { MealCard } from "./card.tsx";
import { Button } from "@/app/components/button.tsx";
import type { Delivery, Menu, DeliveryStatus } from "@forkable-mcp/shared/contracts/meals.ts";
import { DeliveryMetadata } from "@/app/components/delivery-metadata.tsx";
import { MetadataItem } from "@/app/components/metadata-item.tsx";
import { SlidersHorizontal } from "lucide-react";

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
        <DeliveryMetadata service={delivery.service} club={delivery.club} />
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
                ingredients={item?.ingredients}
                restaurant={mealStatus?.venue ?? menu?.name}
                price={mealStatus?.price}
                description={
                  mealStatus?.options.length ? (
                    <MetadataItem icon={SlidersHorizontal}>
                      {mealStatus.options
                        .map((option) => option.replace(/^choose\s+/i, ""))
                        .join(" · ")}
                    </MetadataItem>
                  ) : undefined
                }
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
