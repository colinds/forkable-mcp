import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useMealApp } from "@/app/lib/app-context.ts";
import { navigateMealView } from "@/app/lib/navigate-meal-view.ts";
import type { MealBrowserController } from "./use-meal-browser.ts";

export function useDeepLink(browser: MealBrowserController) {
  const { deepLink, initialLinkRevision, initialLinkError } = useMealApp();
  const router = useRouter();
  const handled = useRef(initialLinkRevision);
  const [error, setError] = useState(initialLinkError);
  const isCurrent = useEffectEvent((revision: number) => deepLink?.revision === revision);
  const guard = useEffectEvent((revision: number) => {
    if (!isCurrent(revision)) throw new Error("A newer link was opened.");
    if (browser.editing || browser.state.busy)
      throw new Error(
        "Close the current meal and finish any pending action before opening this link again.",
      );
    if (browser.state.needsRefresh)
      throw new Error("Refresh the delivery before opening another link.");
  });
  const apply = useEffectEvent(async (url: string, revision: number) => {
    try {
      guard(revision);
      setError(undefined);
      await navigateMealView(router, url, () => guard(revision));
    } catch (failure) {
      if (isCurrent(revision))
        setError(
          failure instanceof Error ? failure.message : "This Forkable link could not be opened.",
        );
    }
  });
  const url = deepLink?.url;
  const revision = deepLink?.revision;
  useEffect(() => {
    if (url === undefined || revision === undefined || revision === handled.current) return;
    handled.current = revision;
    void apply(url, revision);
  }, [url, revision]);
  return error;
}
