import { createMealRouter } from "@/app/router.ts";
import { createMealQueries, createQueryClient } from "@/app/lib/queries.ts";
import { deepLinkPath, type ViewLocation } from "@/app/lib/deep-links.ts";

export function linkRouter() {
  return createMealRouter({
    queryClient: createQueryClient(),
    queries: createMealQueries(async () => {
      throw new Error("Link generation must not fetch data.");
    }),
  });
}
export function viewPath(input: ViewLocation) {
  return deepLinkPath(linkRouter(), input);
}
