// Formatters.

/**
 * Money → "$12.34". The Forkable API returns money as DOLLARS (floats, e.g. 15.85, 22.0), not
 * integer cents (menu item `price` comes back as e.g. 15.85 / 18.5 / 22.0).
 */
export function formatMoney(dollars?: number | null): string {
  if (dollars == null) return "$0.00";
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

/** ISO timestamp → the calendar date it names, as YYYY-MM-DD. See parseFloating on the `Z` caveat. */
export function formatDate(iso?: string): string {
  if (!iso) return "";
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Weekday for a YYYY-MM-DD calendar date, computed from the date parts alone.
 *
 * Callers were re-deriving weekdays from our date strings and getting them wrong, so we emit the
 * weekday ourselves. Parsing at UTC noon keeps the weekday stable regardless of the host timezone.
 */
export function weekdayOf(iso?: string): string {
  const date = formatDate(iso);
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return "";
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? "";
}

/** "2026-08-14T…" → "Fri 2026-08-14". Date-only, with the weekday spelled out. */
export function formatDay(iso?: string): string {
  if (!iso) return "";
  const weekday = weekdayOf(iso);
  return weekday ? `${weekday} ${formatDate(iso)}` : formatDate(iso);
}

const valid = (d: Date): Date | undefined => (Number.isNaN(d.getTime()) ? undefined : d);

/**
 * Parse a Forkable timestamp to a real instant, for comparing against the clock.
 *
 * `editingCutoffAt` carries a true offset, but `forDeliveryAt`'s "…T12:01:00.000Z" is a floating
 * local time mislabelled UTC (lunch isn't delivered at 5:01 AM Pacific), so `new Date()` alone
 * would shift it. Two nudges on top of `Date`, whose offset-less date-time parsing is already
 * local: drop a lying `Z`, and pin a time onto a date-only string, since those parse as UTC.
 */
export function parseFloating(iso?: string): Date | undefined {
  if (!iso) return undefined;
  if (/[+-]\d{2}:?\d{2}$/.test(iso)) return valid(new Date(iso)); // genuine offset: a real instant
  const local = /\d{2}:\d{2}/.test(iso) ? iso.replace(/Z$/i, "") : `${formatDate(iso)}T00:00:00`;
  return valid(new Date(local));
}

/**
 * "2026-08-10T11:45:00-07:00" → "Mon 2026-08-10 11:45 AM".
 *
 * Shown in the offset Forkable sent, matching the dashboard (which parses with Luxon's
 * `{setZone: true}`). That's also the least work: the leading "YYYY-MM-DDTHH:MM" already *is* the
 * wall clock to display — true both for a real offset and for `forDeliveryAt`'s mislabelled `Z` —
 * so this is pure string slicing, with no `Date` and no host-zone dependence.
 */
export function formatDateTime(iso?: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso ?? "");
  if (!m) return formatDay(iso);
  const [, date, hh, mm] = m;
  const h = Number(hh);
  return `${weekdayOf(date)} ${date} ${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** Has this timestamp already passed? `undefined` when there's nothing to compare. */
export function isPast(iso?: string, now: Date = new Date()): boolean | undefined {
  const at = parseFloating(iso);
  return at ? at.getTime() < now.getTime() : undefined;
}
