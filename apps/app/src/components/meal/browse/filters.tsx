import { Search, SlidersHorizontal, RotateCcw, X } from "lucide-react";
import { IconButton } from "@/app/components/icon-button.tsx";
import { Button } from "@/app/components/button.tsx";
import { useRef, useState, useMemo } from "react";
import type { Menu } from "@forkable-mcp/shared/contracts/meals.ts";
import {
  activeFilterCount,
  defaultFilters,
  restaurantMenus,
  type MenuFilters,
} from "@/app/lib/menu-filters.ts";

export function MealFilters({
  menus,
  value,
  query,
  onQueryChange,
  busy,
  onChange,
  onClear,
}: {
  menus: Menu[];
  value: MenuFilters;
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  onChange: (filters: MenuFilters) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const diets = useMemo(
    () =>
      [
        ...new Set(
          menus.flatMap((menu) => menu.items.flatMap((item) => (item.diet ? [item.diet] : []))),
        ),
      ].toSorted(),
    [menus],
  );
  const restaurants = useMemo(() => restaurantMenus(menus), [menus]);
  const active = activeFilterCount(value);
  return (
    <div className="menu-controls">
      <div className="search-toolbar">
        <div className="meal-search">
          <Search aria-hidden="true" />
          <input
            ref={search}
            id="search"
            aria-label="Find a meal"
            type="search"
            className="form-control"
            placeholder="Search dishes, ingredients, or restaurants"
            value={query}
            disabled={busy}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {query && (
            <IconButton
              icon={X}
              className="search-clear"
              label="Clear search"
              disabled={busy}
              onClick={() => {
                onQueryChange("");
                search.current?.focus();
              }}
            />
          )}
        </div>
        <Button
          className="filter-toggle"
          aria-expanded={expanded}
          aria-controls="menu-filter-panel"
          onClick={() => setExpanded(!expanded)}
        >
          <SlidersHorizontal aria-hidden="true" />
          Filters{active > 0 && <span className="filter-count">{active}</span>}
        </Button>
      </div>
      {expanded && (
        <div id="menu-filter-panel" className="menu-filter-panel">
          <fieldset disabled={busy} className="filter-fields">
            <div className="filter-field">
              <label htmlFor="restaurant-filter">Restaurant</label>
              <select
                id="restaurant-filter"
                className="form-control"
                value={value.restaurantId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...value,
                    restaurantId: event.currentTarget.value
                      ? Number(event.currentTarget.value)
                      : undefined,
                  })
                }
              >
                <option value="">All restaurants</option>
                {restaurants.map((menu) => (
                  <option key={menu.menuId} value={menu.menuId}>
                    {menu.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="diet-filter">Dietary label</label>
              <select
                id="diet-filter"
                className="form-control"
                value={value.diet}
                onChange={(event) => onChange({ ...value, diet: event.currentTarget.value })}
              >
                <option value="">All dietary labels</option>
                {diets.map((diet) => (
                  <option key={diet}>{diet}</option>
                ))}
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="price-filter">Maximum price ($)</label>
              <input
                id="price-filter"
                type="number"
                min="0"
                step="0.01"
                className="form-control"
                placeholder="No limit"
                value={value.maxPrice ?? ""}
                onChange={(event) =>
                  onChange({
                    ...value,
                    maxPrice: Number.isFinite(event.currentTarget.valueAsNumber)
                      ? Math.max(0, event.currentTarget.valueAsNumber)
                      : undefined,
                  })
                }
              />
            </div>
            <div className="filter-field">
              <label htmlFor="sort-filter">Sort by</label>
              <select
                id="sort-filter"
                className="form-control"
                value={value.sort}
                onChange={(event) => {
                  const sort = event.currentTarget.value;
                  if (sort === "recommended" || sort === "price-low" || sort === "price-high")
                    onChange({ ...value, sort });
                }}
              >
                <option value="recommended">Recommended first</option>
                <option value="price-low">Price: low to high</option>
                <option value="price-high">Price: high to low</option>
              </select>
            </div>
            <label className="option">
              <input
                type="checkbox"
                checked={value.recommendedOnly}
                onChange={(event) =>
                  onChange({ ...value, recommendedOnly: event.currentTarget.checked })
                }
              />
              Recommended only
            </label>
            <Button
              onClick={() => {
                onChange(defaultFilters);
                onClear();
              }}
            >
              <RotateCcw aria-hidden="true" />
              Clear search and filters
            </Button>
          </fieldset>
          <p className="muted">
            Prices are before paid options. Dietary labels are supplied by Forkable.
          </p>
        </div>
      )}
    </div>
  );
}
