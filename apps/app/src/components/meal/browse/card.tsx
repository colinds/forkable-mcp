import { MealPhoto } from "@/app/components/meal/photo.tsx";
import { MealIngredients } from "../ingredients.tsx";
import type { IngredientCategory } from "@forkable-mcp/shared/contracts/meals.ts";

import { money } from "@forkable-mcp/shared/currency.ts";
import { useId } from "react";

interface MealCardProps {
  name: string;
  imageUrl: string | null;
  restaurant?: string;
  showRestaurant?: boolean;
  price?: number | null;
  ingredients?: IngredientCategory[];
  soldOut?: boolean;
  recommendationRank?: number;
  caption?: string;
  description?: string;
  horizontal?: boolean;
  disabled?: boolean;
  onChoose?: () => void;
  onPrefetch?: () => Promise<void>;
}
export function MealCard({
  name,
  imageUrl,
  restaurant,
  showRestaurant = true,
  price,
  ingredients,
  soldOut,
  recommendationRank,
  caption,
  description,
  horizontal,
  disabled,
  onChoose,
  onPrefetch,
}: MealCardProps) {
  const availabilityId = useId();
  const content = (
    <>
      {(soldOut || recommendationRank !== undefined) && (
        <div className="card-badges">
          {soldOut && (
            <span id={availabilityId} className="sold-out">
              Sold out
            </span>
          )}
          {recommendationRank !== undefined && (
            <span className="recommendation">Recommended · #{recommendationRank}</span>
          )}
        </div>
      )}
      <MealPhoto key={imageUrl} url={imageUrl} name={name} />
      <div className="card-body">
        {caption && <span className="recommendation">{caption}</span>}
        {showRestaurant && restaurant && <p className="muted">{restaurant}</p>}
        <h3>{name}</h3>
        {description && <p className="muted">{description}</p>}
        {price !== undefined && <p className="price">{money(price)}</p>}
        <MealIngredients ingredients={ingredients} />
      </div>
    </>
  );
  const className = `meal-card${horizontal ? " meal-card-horizontal" : ""}${soldOut ? " meal-card-sold-out" : ""}`;
  if (!onChoose) return <article className={className}>{content}</article>;
  return (
    <button
      type="button"
      className={`${className} cursor-interaction`}
      disabled={disabled}
      aria-label={`View ${name}${restaurant ? ` from ${restaurant}` : ""}`}
      aria-describedby={soldOut ? availabilityId : undefined}
      onClick={onChoose}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
    >
      {content}
    </button>
  );
}
