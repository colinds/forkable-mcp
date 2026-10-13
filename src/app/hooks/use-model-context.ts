import { useEffect, useRef, useState, useMemo } from "react";
import { browserContext, type UpdateContext } from "../lib/model-context.ts";

export function useModelContext(
  view: Parameters<typeof browserContext>[0],
  update?: UpdateContext,
) {
  const [failed, setFailed] = useState(false);
  const pending = useRef(Promise.resolve());
  const generation = useRef(0);
  const context = useMemo(
    () => browserContext(view),
    [
      view.delivery,
      view.detail,
      view.query,
      view.filters,
      view.recommendations,
      view.menus,
      view.choices,
      view.source,
      view.needsRefresh,
      view.searchMatches,
    ],
  );
  const latest = useRef(context);
  latest.current = context;
  const snapshot = useMemo(() => JSON.stringify(context), [context]);
  useEffect(() => {
    if (!update) return;
    const current = ++generation.current;
    const payload = latest.current;
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
