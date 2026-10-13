import { MealPhoto } from "./photo.tsx";

import { money } from "@/app/lib/format.ts";

interface MealCardProps {
  name: string;
  imageUrl: string | null;
  restaurant?: string;
  price?: number | null;
  diet?: string | null;
  caption?: string;
  description?: string;
  horizontal?: boolean;
  disabled?: boolean;
  onChoose?: () => void;
}
export function MealCard({
  name,
  imageUrl,
  restaurant,
  price,
  diet,
  caption,
  description,
  horizontal,
  disabled,
  onChoose,
}: MealCardProps) {
  const content = (
    <>
      <MealPhoto key={imageUrl} url={imageUrl} name={name} />
      <div className="card-body">
        {caption && <span className="recommendation">{caption}</span>}
        <h3>{name}</h3>
        {restaurant && <p className="muted">{restaurant}</p>}
        {description && <p className="muted">{description}</p>}
        {price !== undefined && <p className="price">{money(price)}</p>}
        {diet && <p className="muted">{diet}</p>}
      </div>
    </>
  );
  const className = `meal-card${horizontal ? " meal-card-horizontal" : ""}`;
  if (!onChoose) return <article className={className}>{content}</article>;
  return (
    <button
      type="button"
      className={`${className} cursor-interaction`}
      disabled={disabled}
      aria-label={`View ${name}${restaurant ? ` from ${restaurant}` : ""}`}
      onClick={onChoose}
    >
      {content}
    </button>
  );
}
