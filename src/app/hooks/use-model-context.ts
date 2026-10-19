import type { MenuView } from "../lib/menu-filters.ts";
import { useEffect, useRef, useState, useMemo } from "react";
import { browserContext, type UpdateContext } from "../lib/model-context.ts";

export function useModelContext(
  view: Parameters<typeof browserContext>[0],
  menu: MenuView,
  update?: UpdateContext,
) {
  const [failed, setFailed] = useState(false);
  const pending = useRef(Promise.resolve());
  const snapshot = useMemo(
    () => (update ? JSON.stringify(browserContext(view, menu)) : undefined),
    [view, menu, update],
  );
  useEffect(() => {
    if (!update || !snapshot) return;
    const payload: ReturnType<typeof browserContext> = JSON.parse(snapshot);
    let cancelled = false;
    const timer = setTimeout(() => {
      // Send in order and skip superseded snapshots instead of letting stale replies win.
      pending.current = pending.current.then(async () => {
        if (cancelled) return;
        try {
          await update(payload);
          if (!cancelled) setFailed(false);
        } catch {
          if (!cancelled) setFailed(true);
        }
      });
    }, 100);
    return () => {
      clearTimeout(timer);
      cancelled = true;
    };
  }, [snapshot, update]);
  return failed;
}
