import { useEffect, useEffectEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { useMealApp } from "@/app/lib/app-context.ts";
import { browserContext } from "@/app/lib/model-context.ts";
import { showMeals } from "@/app/lib/show-meals.ts";
import type { ShowMealsInput } from "@/app/lib/app-tools.ts";

export function useAppTools(
  view: Parameters<typeof browserContext>[0],
  menu: Parameters<typeof browserContext>[1],
) {
  const { appTools } = useMealApp();
  const router = useRouter();
  const needsRefresh = useEffectEvent(() => view.needsRefresh);
  const read = useEffectEvent(() => browserContext(view, menu));
  const show = useEffectEvent((input: ShowMealsInput, assertCanNavigate: () => void) =>
    showMeals(router, input, assertCanNavigate),
  );
  useEffect(
    () =>
      appTools?.bind({
        read: () => read(),
        show: (input, guard) => show(input, guard),
        needsRefresh: () => needsRefresh(),
      }),
    [appTools],
  );
}

export function useEditorTools(
  view: Parameters<typeof browserContext>[0],
  menu: Parameters<typeof browserContext>[1],
) {
  const { appTools } = useMealApp();
  const read = useEffectEvent(() => browserContext(view, menu));
  useEffect(() => appTools?.bindEditor(() => read()), [appTools]);
}
