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
 * Parse a Forkable timestamp to a real instant.
 *
 * Forkable is inconsistent: `editingCutoffAt` carries a true offset ("2026-08-10T11:45:00-07:00"),
 * but `forDeliveryAt` comes back as "2026-08-11T12:01:00.000Z" — a *floating local* wall-clock time
 * mislabelled UTC (lunch is not delivered at 5:01 AM Pacific). Taking that `Z` at face value shifts
 * the instant by the host's offset and, far enough east, moves the calendar date.
 *
 * `Date` does most of this already: per spec it parses an offset-less date-TIME as local, which is
 * what we want. Two nudges are all it needs — drop the lying `Z`, and pin a time onto a date-ONLY
 * string, since those parse as UTC instead.
 */
export function parseFloating(iso?: string): Date | undefined {
  if (!iso) return undefined;
  if (/[+-]\d{2}:?\d{2}$/.test(iso)) return valid(new Date(iso)); // genuine offset: a real instant
  const local = /\d{2}:\d{2}/.test(iso) ? iso.replace(/Z$/i, "") : `${formatDate(iso)}T00:00:00`;
  return valid(new Date(local));
}

/** "2026-08-10T11:45:00-07:00" → "Mon 2026-08-10 11:45 AM" in the host's timezone. */
export function formatDateTime(iso?: string): string {
  const at = parseFloating(iso);
  if (!at) return formatDay(iso);
  const y = at.getFullYear();
  const mo = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  const time = at
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, " ");
  return `${WEEKDAYS[at.getDay()]} ${y}-${mo}-${d} ${time}`;
}

/** Has this timestamp already passed? `undefined` when there's nothing to compare. */
export function isPast(iso?: string, now: Date = new Date()): boolean | undefined {
  const at = parseFloating(iso);
  return at ? at.getTime() < now.getTime() : undefined;
}
