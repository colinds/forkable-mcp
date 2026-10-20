import { defaultParseSearch } from "@tanstack/react-router";
import type { z } from "zod";
import type { MealRouter } from "@/app/router.ts";
import { openBrowserInputSchema, appUrlSchema } from "@forkable-mcp/shared/contracts/browser.ts";
import { MEAL_PATH, navigationSchema, mealIdentitySchema } from "./navigation.ts";

export interface DeepLink {
  url: string;
  revision: number;
}

export const viewLocationSchema = openBrowserInputSchema.safeExtend({
  sourcePieceId: navigationSchema.shape.sourcePieceId,
});
export type ViewLocation = z.infer<typeof viewLocationSchema>;

type ViewSearch = z.infer<typeof navigationSchema>;
type ViewTarget =
  | { to: "/"; search: ViewSearch }
  | { to: typeof MEAL_PATH; search: ViewSearch; params: z.infer<typeof mealIdentitySchema> };

export function viewTarget(input: ViewLocation): ViewTarget {
  const location = viewLocationSchema.parse(input);
  const search = navigationSchema.parse(location);
  if (location.deliveryId != null && location.menuId != null && location.itemId != null)
    return { to: MEAL_PATH, params: mealIdentitySchema.parse(location), search };
  if (location.sourcePieceId !== undefined)
    throw new Error("A selected meal link needs its delivery, menu, and item.");
  return { to: "/", search };
}

export function deepLinkInput(router: Pick<MealRouter, "matchRoutes">, path: string): ViewTarget {
  const url = new URL(path, "https://forkable.invalid");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== "https://forkable.invalid" ||
    url.hash
  )
    throw new Error("This Forkable link is not supported.");
  const matches = router.matchRoutes(url.pathname, defaultParseSearch(url.search), {
    throwOnError: true,
  });
  const match = matches.at(-1);
  if (!match || (match.routeId !== "/" && match.routeId !== MEAL_PATH))
    throw new Error("This Forkable view does not exist.");
  return viewTarget({
    ...navigationSchema.parse(match.search),
    ...(match.routeId === MEAL_PATH ? mealIdentitySchema.parse(match.params) : {}),
  });
}

export function deepLinkPath(
  router: Pick<MealRouter, "buildLocation">,
  input: ViewLocation,
): string {
  return router.buildLocation(viewTarget(input)).href;
}

export function viewLink(appUrl: string, path: string): string {
  const url = new URL(appUrlSchema.parse(appUrl));
  url.searchParams.set("path", path);
  return url.toString();
}
