import type { MenuView } from "../lib/menu-filters.ts";
import { useEffect, useRef, useState, useMemo } from "react";
import { browserContext, type UpdateContext } from "../lib/model-context.ts";

export function useModelContext(
  view: Parameters<typeof browserContext>[0],
  menu: MenuView,
  update?: UpdateContext,
  ready = true,
) {
  const [failed, setFailed] = useState(false);
  const pending = useRef(Promise.resolve());
  const generation = useRef(0);
  const context = useMemo(
    () => (update && ready ? browserContext(view, menu) : undefined),
    [
      view.delivery,
      view.detail,
      view.query,
      view.filters,
      menu,
      update,
      ready,
      view.choices,
      view.source,
      view.needsRefresh,
    ],
  );
  const latest = useRef(context);
  latest.current = context;
  const snapshot = useMemo(() => JSON.stringify(context), [context]);
  useEffect(() => {
    const payload = latest.current;
    if (!update || !payload) return;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      // Send in order and skip superseded snapshots instead of letting stale replies win.
      pending.current = pending.current.then(async () => {
        if (current !== generation.current) return;
        try {
          await update(payload);
          if (current === generation.current) setFailed(false);
        } catch {
          if (current === generation.current) setFailed(true);
        }
      });
    }, 100);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [snapshot, update]);
  return failed;
}
