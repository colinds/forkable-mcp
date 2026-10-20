import type { MealRouter } from "@/app/router.ts";
import { deepLinkInput } from "./deep-links.ts";

export async function navigateMealView(
  router: MealRouter,
  path: string,
  assertCanNavigate: () => void,
) {
  const target = deepLinkInput(router, path);
  const start = router.state.location.href;
  const matches = await router.preloadRoute(target);
  const failed = matches?.find((match) => match.status === "error");
  if (failed) throw failed.error;
  assertCanNavigate();
  if (router.options.context.queryClient.isMutating())
    throw new Error("Wait for the current meal action to finish.");
  if (router.state.location.href !== start)
    throw new Error("The view changed while this link was loading. Open it again.");
  await router.navigate({ ...target, resetScroll: false });
}
