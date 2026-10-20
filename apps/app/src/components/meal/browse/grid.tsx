import { type MenuView } from "@/app/lib/menu-filters.ts";
import { itemKey } from "@/app/lib/tools.ts";
import { type Menu } from "@forkable-mcp/shared/contracts/meals.ts";
import { MealCard } from "./card.tsx";
import { MealCardsLoading } from "./loading.tsx";

export function MealCards({
  menus,
  view,
  query,
  busy,
  loading,
  choose,
  prefetchMeal,
}: {
  menus: Menu[];
  view: MenuView;
  query: string;
  busy: boolean;
  loading: boolean;
  choose: (menuId: number, itemId: number) => void;
  prefetchMeal: (menuId: number, itemId: number) => Promise<void>;
}) {
  const { items, restaurants, layout } = view;
  if (loading && !items.length) return <MealCardsLoading />;
  let empty = menus.length
    ? "No meals match these filters. Try clearing your search and filters."
    : "No menus available for this delivery.";
  if (query.trim()) empty = "No meals match your search.";
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
            onPrefetch={() => prefetchMeal(menu.menuId, item.itemId)}
          />
        ))}
      </div>
    );
  }
  return (
    <section className="meal-results" aria-label="Available meals">
      <p className="result-count muted" aria-live="polite">
        {items.length} {items.length === 1 ? "meal" : "meals"}
        {query.trim()
          ? ` matching “${query.trim()}”`
          : ` across ${restaurants.length} ${restaurants.length === 1 ? "restaurant" : "restaurants"}`}
      </p>
      {!items.length && <p className="empty">{empty}</p>}
      {layout === "results"
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
