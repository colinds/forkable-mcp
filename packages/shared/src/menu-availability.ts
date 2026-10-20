import type { Delivery, Menu } from "./contracts/meals.ts";

export function isMenuSoldOut(
  menu: Pick<Menu, "menuId" | "capacityStatus"> | undefined,
  replacing?: Pick<Delivery["meals"][number], "menuId" | "canSwapAtCapacity">,
): boolean {
  if (!menu) return false;
  if (menu.menuId === replacing?.menuId && replacing.canSwapAtCapacity) return false;
  if (menu.capacityStatus === "at_capacity") return menu.menuId !== replacing?.menuId;
  return menu.capacityStatus === "over_capacity";
}
