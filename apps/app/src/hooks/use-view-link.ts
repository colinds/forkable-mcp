import { useParams, useSearch, useRouter } from "@tanstack/react-router";
import { useMealApp } from "@/app/lib/app-context.ts";
import { MEAL_PATH } from "@/app/lib/navigation.ts";
import { deepLinkPath, viewLink } from "@/app/lib/deep-links.ts";
import type { MealBrowserController } from "./use-meal-browser.ts";

export function useViewLink({
  delivery,
  deliveries,
}: Pick<MealBrowserController["state"], "delivery" | "deliveries">) {
  const { appUrl } = useMealApp();
  const router = useRouter();
  const search = useSearch({ from: "__root__" });
  const params = useParams({ from: MEAL_PATH, shouldThrow: false });
  if (!appUrl) return undefined;
  const path = deepLinkPath(router, {
    ...search,
    from: search.from ?? deliveries[0]?.date,
    to: search.to ?? deliveries.at(-1)?.date,
    deliveryId: delivery?.deliveryId,
    ...params,
  });
  return viewLink(appUrl, path);
}
