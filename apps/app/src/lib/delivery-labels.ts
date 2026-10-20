/** ETA status and order lifecycle are separate: an open order is not a courier update. */
export function fulfillmentLabel(status: string | null | undefined): string {
  switch (status) {
    case "ontime":
      return "Arriving on time";
    case "delayed":
      return "Delayed";
    case "delivered":
      return "Delivered";
    case "partially delivered":
      return "Partially delivered";
    case "mixed":
      return "Updates vary by restaurant";
    case "in flight":
      return "Delivery in progress";
    case "initial":
    case "hidden":
    case "grace_period":
      return "Awaiting delivery updates";
    default:
      return "Delivery status unavailable";
  }
}

export function serviceLabel(service: string | null | undefined): string | undefined {
  if (!service) return undefined;
  const label = service === "afternoon" ? "dinner" : service;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function deliveryZoneLabel(
  timezone: string | null | undefined,
  date: string,
  deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined {
  if (!timezone) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    });
    if (formatter.resolvedOptions().timeZone === deviceTimezone) return undefined;
    return formatter
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}
export function arrivalTime(iso: string | null, timezone: string | null): string | null {
  if (!iso || !/(Z|[+-]\d{2}:?\d{2})$/.test(iso) || !Number.isFinite(Date.parse(iso))) return null;
  if (timezone) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(iso));
    } catch {
      /* Fall back to the source offset, never the browser's timezone. */
    }
  }
  const match = /T(\d{2}):(\d{2}).*(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!match) return null;
  return `${clockTime(`${match[1]}:${match[2]}`)} ${match[3] === "Z" ? "UTC" : `UTC${match[3]}`}`;
}
export function clockTime(clock: string): string {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(clock);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return clock;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}
export function trackingUrl(value: string | null): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Use a consistent 12-hour range with one trailing timezone. */
export function arrivalRange(
  start: string | null,
  end: string | null,
  timezone: string | null,
): string | null {
  const left = arrivalTime(start, timezone);
  const right = arrivalTime(end, timezone);
  if (!left || !right) return null;
  const zone = / (?:[A-Z]{2,5}|UTC[+-]\d{2}:?\d{2})$/.exec(right)?.[0];
  return `${zone && left.endsWith(zone) ? left.slice(0, -zone.length) : left}–${right}`;
}

const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function dateLabels(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return { weekday: "Delivery", date };
  return {
    weekday: weekdayFormatter.format(value),
    date: dateFormatter.format(value),
  };
}
