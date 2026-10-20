import type { MealRouter } from "@/app/router.ts";
import type { InitialView } from "./initial-view.ts";
import { initialLaunch, isPastDelivery } from "./initial-view.ts";
import { MEAL_PATH, navigationSchema } from "./navigation.ts";

export async function navigateMealView(
  router: MealRouter,
  input: InitialView["input"],
  assertCanNavigate: () => void,
) {
  const { queryClient, queries } = router.options.context;
  if (queryClient.isMutating()) throw new Error("Wait for the current meal action to finish.");
  const startLocation = router.state.location.href;
  function checkNavigation() {
    assertCanNavigate();
    if (queryClient.isMutating()) throw new Error("Wait for the current meal action to finish.");
    if (router.state.location.href !== startLocation)
      throw new Error(
        "The user changed views while loading. Read the current view before trying again.",
      );
  }
  const launch = initialLaunch({ input, result: { content: [] } });
  const search = navigationSchema.parse({ ...input, view: launch.view, filters: launch.filters });
  const deliveries = await queryClient.ensureQueryData(queries.deliveries(search));
  const delivery =
    input.deliveryId == null
      ? deliveries[0]
      : deliveries.find((candidate) => candidate.deliveryId === input.deliveryId);
  if (input.deliveryId != null && !delivery)
    throw new Error(
      "This delivery is not in the requested date range. Choose a delivery from list_deliveries.",
    );
  search.deliveryId = delivery?.deliveryId;
  const identity =
    input.deliveryId != null && input.menuId != null && input.itemId != null
      ? { deliveryId: input.deliveryId, menuId: input.menuId, itemId: input.itemId }
      : undefined;
  if (identity) {
    if (!delivery) throw new Error("This delivery is not available.");
    if (isPastDelivery(delivery.date))
      throw new Error("Meal details are unavailable for past deliveries.");
    const menus = await queryClient.ensureQueryData(queries.menus(delivery));
    const menu = menus.find((candidate) => candidate.menuId === input.menuId);
    if (!menu?.items.some((item) => item.itemId === input.itemId))
      throw new Error("The menu and item do not match an available meal on this delivery.");
    checkNavigation();
    await router.navigate({
      to: MEAL_PATH,
      params: identity,
      search,
      resetScroll: false,
    });
  } else {
    checkNavigation();
    await router.navigate({ to: "/", search, resetScroll: false });
  }
  if (router.state.matches.some((match) => match.status === "error"))
    throw new Error("Forkable could not load the requested view. Refresh the app to try again.");
}
