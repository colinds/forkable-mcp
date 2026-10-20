import { activeFilterCount, defaultFilters } from "./menu-filters.ts";
import { browserInputSchema, type BrowserView } from "@/shared/contracts/browser.ts";
import type { z } from "zod";
import { todayLocal } from "@/shared/dates.ts";
import { type ToolResult } from "./tools.ts";
import {
  deliveriesSchema,
  searchResultsSchema,
  menusSchema,
  itemDetailSchema,
  recommendationsSchema,
  deliveryStatusSchema,
} from "@/shared/contracts/meals.ts";

export interface InitialView {
  input: z.infer<typeof browserInputSchema>;
  result: ToolResult;
}

export function initialData(view?: InitialView) {
  const result = view?.result.structuredContent;
  return {
    deliveries: deliveriesSchema.safeParse(result).data?.deliveries,
    menus: menusSchema.safeParse(result).data?.menus,
    item: itemDetailSchema.safeParse(result).data?.item,
    recommendations: recommendationsSchema.safeParse(result).data?.recommendations,
    status: deliveryStatusSchema.safeParse(result).data?.status,
    searchItems: searchResultsSchema.safeParse(result).data?.items,
  };
}

export function initialLaunch(initial?: InitialView) {
  const seed = initialData(initial);
  const input = initial?.input;
  const filters = input?.filters ?? {
    ...defaultFilters,
    recommendedOnly: seed.recommendations !== undefined,
  };
  let view: BrowserView = "browse";
  if (input?.view) view = input.view;
  else if (
    input?.query?.trim() ||
    activeFilterCount(filters) ||
    seed.searchItems !== undefined ||
    seed.menus !== undefined ||
    seed.item ||
    input?.itemId != null
  )
    view = "meals";
  else if (seed.status || seed.deliveries !== undefined || input?.deliveryId != null)
    view = "delivery";
  return { view, filters, showDates: (seed.deliveries?.length ?? 0) > 1, limit: input?.limit };
}

export const isPastDelivery = (date: string, today = todayLocal()) => date < today;

export function initialRange(
  view?: InitialView,
  today = todayLocal(),
): { from?: string; to?: string } {
  const input = view?.input;
  const date = deliveryStatusSchema.safeParse(view?.result.structuredContent).data?.status?.date;
  if (date && isPastDelivery(date, today)) return { from: date, to: date };
  return { ...(input?.from ? { from: input.from } : {}), ...(input?.to ? { to: input.to } : {}) };
}
