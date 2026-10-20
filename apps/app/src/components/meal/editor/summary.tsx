import type { Delivery } from "@forkable-mcp/shared/contracts/meals.ts";
import { money } from "@forkable-mcp/shared/currency.ts";
import type { MealPreview } from "@/app/lib/editor-types.ts";
import { MealPhoto } from "@/app/components/meal/photo.tsx";
import { MealIngredients } from "../ingredients.tsx";
import { DeliveryMetadata } from "@/app/components/delivery-metadata.tsx";

export function MealSummary({ meal, delivery }: { meal: MealPreview; delivery?: Delivery }) {
  return (
    <div className="detail-summary">
      <MealPhoto key={meal.imageUrl} url={meal.imageUrl} name={meal.name} />
      {delivery && (
        <DeliveryMetadata date={delivery.date} service={delivery.service} club={delivery.club} />
      )}
      <p className="price">{money(meal.price)}</p>
      {meal.description && <p>{meal.description}</p>}
      <MealIngredients ingredients={meal.ingredients} />
    </div>
  );
}
