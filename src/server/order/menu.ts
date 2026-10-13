import { type Menu as PublicMenu, type Detail } from "@/shared/contracts/meals.ts";
import { resolveItemModifiers } from "@/server/order/selections.ts";
import { formatMoney } from "@/server/order/format.ts";
import { type Menu, type MenuItem } from "@/server/order/types.ts";

export function formatKnownPrice(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatMoney(value)
    : "price unavailable";
}

type ResolvedItem = { item: MenuItem; menu: Menu };

export function flattenItems(menus: Menu[]): ResolvedItem[] {
  return menus.flatMap((menu) =>
    menu.sections.flatMap((s) => s.items.map((item) => ({ item, menu }))),
  );
}

// Item ids are not unique across menus; identity is the (menuId, itemId) pair.
export function findItem(
  items: ResolvedItem[],
  menuId: number,
  itemId: number,
): ResolvedItem | undefined {
  return items.find((x) => x.menu.id === menuId && x.item.id === itemId);
}

function matchItemId(items: ResolvedItem[], itemId: number, menuId?: number): ResolvedItem[] {
  return items.filter((x) => x.item.id === itemId && (menuId == null || x.menu.id === menuId));
}

/** Resolve exactly one item/menu pair. */
export function resolveOneItem(
  menus: Menu[],
  itemId: number,
  menuId: number | undefined,
  deliveryId: number,
): ResolvedItem {
  const matches = matchItemId(flattenItems(menus), itemId, menuId);
  if (matches.length === 0) {
    throw new Error(`Item ${itemId} is not on any menu available for delivery ${deliveryId}.`);
  }
  if (matches.length > 1) {
    const ids = [...new Set(matches.map((m) => m.menu.id))].join(", ");
    throw new Error(
      `Item ${itemId} appears on multiple menus for delivery ${deliveryId} (menus: ${ids}); ` +
        `pass menuId to disambiguate.`,
    );
  }
  return matches[0]!;
}

export function resolveExactItem(
  menus: Menu[],
  menuId: number,
  itemId: number,
  deliveryId: number,
): ResolvedItem {
  const matches = flattenItems(menus).filter(
    (x) => x.menu.id === menuId && x.item.menuId === menuId && x.item.id === itemId,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Menu ${menuId} contains item ${itemId} more than once; refusing an ambiguous write.`
        : `Item ${itemId} was not found on menu ${menuId} for delivery ${deliveryId}.`,
    );
  }
  return matches[0]!;
}

/** Menu and item identity plus the fields needed to choose what to order. */
export function compactMenus(menus: Menu[], diets?: Map<number, string>): PublicMenu[] {
  return menus.map((m) => ({
    menuId: m.id,
    name: m.displayName || m.name || `menu ${m.id}`,
    items: m.sections
      .flatMap((section) => section.items)
      .map((item) => ({
        itemId: item.id,
        name: item.name,
        price: item.price ?? null,
        imageUrl: item.imageUrl ?? null,
        description: item.description ?? null,
        diet: item.dietLevel != null ? (diets?.get(item.dietLevel) ?? null) : null,
        hasModifiers: (item.modifiers?.length ?? 0) > 0,
      })),
  }));
}

export function compactItemDetail(detail: ReturnType<typeof itemDetail>): Detail {
  return {
    menuId: detail.menuId,
    itemId: detail.id,
    name: detail.name,
    price: detail.price,
    description: detail.description,
    imageUrl: detail.imageUrl,
    modifiers: detail.modifiers,
  };
}

/** Full modifiers and options for one requested item. */
export function itemDetail(item: MenuItem, menu: Menu) {
  return {
    menuId: menu.id,
    id: item.id,
    name: item.name,
    price: item.price ?? null,
    description: item.description ?? null,
    imageUrl: item.imageUrl ?? null,
    modifiers: resolveItemModifiers(item).map((mod) => ({
      id: mod.id,
      name: mod.display || mod.name || `modifier ${mod.id}`,
      required: !!mod.required,
      min: mod.min ?? null,
      max: mod.max ?? null,
      options: mod.options.map((o) => ({ id: o.id, name: o.name, price: o.price ?? 0 })),
    })),
  };
}

/** Human-readable rendering of an itemDetail(). */
export function fmtItemDetail(d: ReturnType<typeof itemDetail>): string {
  return [
    `${d.name}  ${formatKnownPrice(d.price)}${d.description ? ` — ${d.description}` : ""}`,
    ...d.modifiers.map((mod) => {
      const req = mod.required ? " (required)" : "";
      const opts = mod.options
        .map((o) => `${o.id}:${o.name}${o.price ? ` +${formatMoney(o.price)}` : ""}`)
        .join(", ");
      return `  ${mod.name}${req} [${mod.min ?? 0}-${mod.max ?? "∞"}]: ${opts}`;
    }),
  ].join("\n");
}

// Markdown keeps dish images visible in clients that render tool text.
export function imageMd(item: { name: string; imageUrl?: string | null }): string {
  return item.imageUrl ? `\n      ![${item.name}](${item.imageUrl})` : "";
}
