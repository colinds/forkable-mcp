import { useEffect, useRef, useMemo } from "react";
import type { Delivery } from "@forkable/shared/contracts/meals.ts";

import { dateLabels } from "@/app/lib/delivery-labels.ts";

export function DateStrip({
  deliveries,
  selectedId,
  busy,
  onSelect,
}: {
  deliveries: Delivery[];
  selectedId?: number;
  busy: boolean;
  onSelect: (id: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const dateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const delivery of deliveries)
      counts.set(delivery.date, (counts.get(delivery.date) ?? 0) + 1);
    return counts;
  }, [deliveries]);
  useEffect(() => {
    if (selectedId == null) return;
    strip.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  return (
    <div
      className="date-strip"
      role="group"
      aria-label="Delivery dates"
      ref={strip}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(
          strip.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        let next = index + (event.key === "ArrowRight" ? 1 : -1);
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = buttons.length - 1;
        buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
      }}
    >
      {deliveries.map((delivery) => {
        const label = dateLabels(delivery.date);
        const sameDay = (dateCounts.get(delivery.date) ?? 0) > 1;
        return (
          <button
            type="button"
            key={delivery.deliveryId}
            className="date-chip cursor-interaction"
            aria-pressed={delivery.deliveryId === selectedId}
            aria-label={`${label.weekday}, ${label.date}, ${delivery.service ?? "delivery"}${delivery.club ? `, ${delivery.club}` : ""}`}
            disabled={busy}
            onClick={() => onSelect(delivery.deliveryId)}
          >
            <span className="muted">{label.weekday}</span>
            <time dateTime={delivery.date}>{label.date}</time>
            {sameDay ? (
              <span className="date-context">
                {delivery.service}
                {delivery.club ? ` · ${delivery.club}` : ""}
              </span>
            ) : (
              <span className="muted">
                {delivery.meals.length ? "Meal selected" : "Choose a meal"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
