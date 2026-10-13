import { useMemo } from "react";
import { visibleMeals, restaurantGroups, type MenuFilters } from "../../lib/menu-filters.ts";
import { itemKey, type Menu, type Recommendation, type SearchMatch } from "../../lib/model.ts";
import { MealCard } from "./card.tsx";

export function MealCards({
  menus,
  recommendations,
  query,
  filters,
  searchMatches,
  busy,
  choose,
}: {
  menus: Menu[];
  recommendations: Recommendation[];
  query: string;
  filters: MenuFilters;
  searchMatches?: SearchMatch[];
  busy: boolean;
  choose: (menuId: number, itemId: number) => void;
}) {
  const items = useMemo(
    () => visibleMeals(menus, recommendations, query, filters, searchMatches),
    [menus, recommendations, query, filters, searchMatches],
  );
  const searching = query.trim().length > 0;
  const restaurants = useMemo(() => restaurantGroups(menus, items), [menus, items]);
  let empty = menus.length
    ? "No meals match these filters. Try clearing your search and filters."
    : "No menus available for this delivery.";
  if (searching) empty = "No meals match your search.";
  if (busy) empty = "Loading meals…";
  function cards(results: typeof items) {
    return (
      <div className="meals">
        {results.map(({ menu, item, rank }) => (
          <MealCard
            key={itemKey(menu.menuId, item.itemId)}
            name={item.name}
            imageUrl={item.imageUrl}
            restaurant={menu.name}
            price={item.price}
            diet={item.diet}
            caption={rank ? `Recommended · #${rank}` : undefined}
            disabled={busy}
            onChoose={() => choose(menu.menuId, item.itemId)}
          />
        ))}
      </div>
    );
  }
  return (
    <section className="meal-results" aria-label="Available meals">
      <p className="result-count muted" aria-live="polite">
        {items.length} {items.length === 1 ? "meal" : "meals"}
        {searching
          ? ` matching “${query.trim()}”`
          : ` across ${restaurants.length} ${restaurants.length === 1 ? "restaurant" : "restaurants"}`}
      </p>
      {!items.length && <p className="empty">{empty}</p>}
      {searching
        ? cards(items)
        : restaurants.map((group) => (
            <section key={group.name} className="restaurant-group" aria-label={group.name}>
              <div className="restaurant-heading">
                <h3>{group.name}</h3>
                <span className="muted">
                  {group.items.length} {group.items.length === 1 ? "meal" : "meals"}
                </span>
              </div>
              {cards(group.items)}
            </section>
          ))}
    </section>
  );
}
