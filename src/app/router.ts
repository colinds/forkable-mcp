import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  createMemoryHistory,
  defaultStringifySearch,
  redirect,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { MealBrowserPage } from "@/app/pages/browser.tsx";
import { MealEditorPage } from "@/app/pages/meal/page.tsx";
import { MealPending } from "@/app/pages/meal/pending.tsx";
import { MealLoadError } from "@/app/pages/error.tsx";
import { MealRouteError } from "@/app/pages/meal/error.tsx";
import { resultText } from "@/app/lib/tools.ts";
import { MealAppLoading } from "@/app/pages/loading.tsx";
import { isPastDelivery, type InitialView } from "@/app/lib/initial-view.ts";
import { MEAL_PATH, navigationSchema, parseMealParams } from "@/app/lib/navigation.ts";
import type { MealQueries } from "@/app/lib/queries.ts";

interface RouterContext {
  queryClient: QueryClient;
  queries: MealQueries;
  initial?: InitialView;
}

const root = createRootRouteWithContext<RouterContext>()({
  validateSearch: navigationSchema,
  loaderDeps: ({ search }) => ({ deliveryId: search.deliveryId }),
  beforeLoad: ({ context }) => {
    if (
      context.initial?.result.isError &&
      !context.queryClient.getQueryData(context.queries.deliveries().queryKey)
    )
      throw new Error(resultText(context.initial.result) || "Forkable could not load this view.");
  },
  loader: async ({ context, deps }) => {
    const initialLoad =
      context.queryClient.getQueryData(context.queries.deliveries().queryKey) === undefined;
    const deliveries = await context.queryClient.ensureQueryData(context.queries.deliveries());
    const selected =
      deps.deliveryId == null
        ? deliveries[0]
        : deliveries.find((d) => d.deliveryId === deps.deliveryId);
    if (initialLoad && selected)
      await context.queryClient.ensureQueryData(context.queries.menus(selected));
  },
  component: MealBrowserPage,
  errorComponent: MealLoadError,
  pendingComponent: MealAppLoading,
});
const browse = createRoute({ getParentRoute: () => root, path: "/" });
const meal = createRoute({
  getParentRoute: () => root,
  path: MEAL_PATH,
  params: {
    parse: parseMealParams,
    stringify: (params) => ({
      deliveryId: String(params.deliveryId),
      menuId: String(params.menuId),
      itemId: String(params.itemId),
    }),
  },
  loader: async ({ context, params }) => {
    const deliveries = await context.queryClient.ensureQueryData(context.queries.deliveries());
    const delivery = deliveries.find((candidate) => candidate.deliveryId === params.deliveryId);
    if (!delivery)
      throw new Error(
        "This delivery is not in the requested date range. Refresh to see current deliveries.",
      );
    if (isPastDelivery(delivery.date))
      throw redirect({
        to: "/",
        search: (previous) => ({ ...previous, deliveryId: delivery.deliveryId }),
      });
  },
  component: MealEditorPage,
  remountDeps: ({ params, search }) => ({ ...params, sourcePieceId: search.sourcePieceId }),
  pendingComponent: MealPending,
  errorComponent: MealRouteError,
});
const routeTree = root.addChildren([browse, meal]);

export function createMealRouter(context: RouterContext) {
  const input = context.initial?.input;
  const { launch, seed } = context.queries;
  const search = navigationSchema.parse({
    ...input,
    deliveryId: input?.deliveryId ?? seed.status?.deliveryId,
    view: launch.view,
    filters: launch.filters,
    serverSearch: seed.searchItems !== undefined,
  });
  const pathname =
    input?.deliveryId != null && input.menuId != null && input.itemId != null
      ? `/delivery/${input.deliveryId}/menu/${input.menuId}/item/${input.itemId}`
      : "/";
  return createRouter({
    routeTree,
    context,
    history: createMemoryHistory({
      initialEntries: [`${pathname}${defaultStringifySearch(search)}`],
    }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
    defaultStaleTime: Infinity,
    defaultPreload: false,
  });
}
export type MealRouter = ReturnType<typeof createMealRouter>;
declare module "@tanstack/react-router" {
  interface Register {
    router: MealRouter;
  }
}
