import type { IngredientCategory } from "@forkable-mcp/shared/contracts/meals.ts";

export function MealIngredients({ ingredients }: { ingredients?: IngredientCategory[] }) {
  const labels = ingredients?.map(
    (ingredient) => ingredient.charAt(0).toUpperCase() + ingredient.slice(1),
  );
  if (!labels?.length) return null;
  return (
    <ul
      className="meal-ingredients muted"
      aria-label="Reported ingredients"
      title={labels.join(" · ")}
    >
      {labels.map((label) => (
        <li key={label}>{label}</li>
      ))}
    </ul>
  );
}
