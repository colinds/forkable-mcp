import { itemKey } from "./tools.ts";
import type { Menu, Recommendation, SearchMatch } from "@forkable/shared/contracts/meals.ts";
import { menuFiltersSchema, type MenuFilters } from "@forkable/shared/contracts/menu-filters.ts";
export type { MenuFilters } from "@forkable/shared/contracts/menu-filters.ts";

export const defaultFilters: MenuFilters = menuFiltersSchema.parse({});

export function activeFilterCount(filters: MenuFilters): number {
  return (
    Number(filters.restaurantId != null) +
    Number(!!filters.diet) +
    Number(filters.maxPrice != null) +
    Number(filters.recommendedOnly) +
    Number(filters.sort !== defaultFilters.sort)
  );
}

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
export const restaurantKey = (name: string) => name.trim().toLowerCase();
export function restaurantMenus(menus: Menu[]): Menu[] {
  const unique = new Map<string, Menu>();
  for (const menu of menus)
    if (!unique.has(restaurantKey(menu.name))) unique.set(restaurantKey(menu.name), menu);
  return [...unique.values()];
}
export function visibleMeals(
  menus: Menu[],
  recommendations: Recommendation[],
  query: string,
  filters: MenuFilters,
  searchMatches?: SearchMatch[],
) {
  const restaurant = menus.find((menu) => menu.menuId === filters.restaurantId);
  const sourceOrder =
    searchMatches == null
      ? undefined
      : new Map(searchMatches.map((item, index) => [itemKey(item.menuId, item.itemId), index]));
  const ranks = new Map(recommendations.map((r) => [itemKey(r.menuId, r.itemId), r.rank]));
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return menus
    .flatMap((menu) =>
      menu.items.map((item) => ({
        menu,
        item,
        rank: ranks.get(itemKey(menu.menuId, item.itemId)),
      })),
    )
    .filter(({ menu, item, rank }) => {
      const matchesFilters =
        (filters.restaurantId == null ||
          (restaurant != null && restaurantKey(menu.name) === restaurantKey(restaurant.name))) &&
        (!filters.diet || item.diet === filters.diet) &&
        (filters.maxPrice == null || (item.price != null && item.price <= filters.maxPrice)) &&
        (!filters.recommendedOnly || rank != null);
      if (!matchesFilters) return false;
      if (sourceOrder) return sourceOrder.has(itemKey(menu.menuId, item.itemId));
      if (!terms.length) return true;
      const text = normalize(
        `${menu.name} ${item.name} ${item.description ?? ""} ${item.diet ?? ""}`,
      );
      return terms.every((term) => text.includes(term));
    })
    .toSorted((a, b) => {
      if (filters.sort !== "recommended") {
        if (a.item.price == null) return b.item.price == null ? 0 : 1;
        if (b.item.price == null) return -1;
        return filters.sort === "price-low"
          ? a.item.price - b.item.price
          : b.item.price - a.item.price;
      }
      if (sourceOrder)
        return (
          sourceOrder.get(itemKey(a.menu.menuId, a.item.itemId))! -
          sourceOrder.get(itemKey(b.menu.menuId, b.item.itemId))!
        );
      return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.item.name.localeCompare(b.item.name);
    });
}

/** Keep restaurant sections stable while preserving the chosen ordering inside each menu. */
export function restaurantGroups(menus: Menu[], items: ReturnType<typeof visibleMeals>) {
  const groups = new Map<string, { name: string; items: typeof items }>();
  for (const menu of menus) {
    const key = restaurantKey(menu.name);
    if (!groups.has(key)) groups.set(key, { name: menu.name, items: [] });
  }
  for (const result of items) groups.get(restaurantKey(result.menu.name))?.items.push(result);
  return [...groups.values()].filter((group) => group.items.length);
}

export function menuView({
  menus,
  recommendations,
  query,
  filters,
  searchMatches,
  layout = query.trim() ? "results" : "restaurants",
}: {
  menus: Menu[];
  recommendations: Recommendation[];
  query: string;
  filters: MenuFilters;
  searchMatches?: SearchMatch[];
  layout?: "results" | "restaurants";
}) {
  const items = visibleMeals(menus, recommendations, query, filters, searchMatches);
  const restaurants = restaurantGroups(menus, items);
  return {
    items,
    restaurants,
    layout,
    ordered: layout === "results" ? items : restaurants.flatMap((group) => group.items),
  };
}

export type MenuView = ReturnType<typeof menuView>;
