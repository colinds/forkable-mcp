/** Format dollar values. Order total/serviceFee/tally use cents and must not reach this helper. */
export function formatMoney(dollars?: number | null): string {
  if (dollars == null) return "$0.00";
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

/** Extract the named YYYY-MM-DD calendar date without timezone conversion. */
export function formatDate(iso?: string): string {
  if (!iso) return "";
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Weekday for a calendar date, anchored at UTC noon for host-zone stability. */
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
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Parse Forkable floating-local timestamps; true offsets remain real instants. */
export function parseFloating(iso?: string): Date | undefined {
  if (!iso) return undefined;
  if (/[+-]\d{2}:?\d{2}$/.test(iso)) return valid(new Date(iso)); // genuine offset: a real instant
  const local = /\d{2}:\d{2}/.test(iso) ? iso.replace(/Z$/i, "") : `${formatDate(iso)}T00:00:00`;
  return valid(new Date(local));
}

/** Format the wall clock exactly as named by the timestamp, without host-zone conversion. */
export function formatDateTime(iso?: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso ?? "");
  if (!m) return formatDay(iso);
  const [, date, hh, mm] = m;
  const h = Number(hh);
  return `${weekdayOf(date)} ${date} ${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** Parse an honest-UTC instant. `undefined` unless it really carries a `Z`. */
function utcInstant(utcIso?: string): Date | undefined {
  // This timestamp family uses an actual UTC `Z`, unlike floating delivery timestamps.
  return utcIso && /Z$/i.test(utcIso) ? valid(new Date(utcIso)) : undefined;
}

/** Format a UTC instant in an explicit IANA zone; returns empty when either is unusable. */
export function formatInstantIn(utcIso?: string, zone?: string, label?: string): string {
  const at = utcInstant(utcIso);
  if (!at || !zone) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(at);
  } catch {
    return ""; // unknown zone name — omit rather than guess
  }
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const shown = `${g("weekday")} ${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ${g("dayPeriod")}`;
  return label ? `${shown} ${label}` : shown;
}

/** Format a UTC instant using the explicit offset from a sibling timestamp. */
export function formatInstantLike(utcIso?: string, zoneSource?: string, label?: string): string {
  const off = /([+-])(\d{2}):?(\d{2})$/.exec(zoneSource ?? "");
  const at = utcInstant(utcIso);
  if (!off || !at) return "";
  const offset = `${off[1]}${off[2]}:${off[3]}`;
  const minutes = (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
  const shifted = new Date(at.getTime() + minutes * 60_000);
  const wall =
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}${offset}`;
  return label ? `${formatDateTime(wall)} ${label}` : formatDateTime(wall);
}

/**
 * Time remaining until an explicit-offset instant. Offset-less values are rejected to avoid
 * host-dependent countdowns; partial minutes round up.
 */
export function formatCountdown(iso?: string, now: Date = new Date()): string {
  const zoned = iso && /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const at = zoned ? valid(new Date(iso)) : undefined;
  if (!at) return "";
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** Has this timestamp already passed? `undefined` when there's nothing to compare. */
export function isPast(iso?: string, now: Date = new Date()): boolean | undefined {
  const at = parseFloating(iso);
  return at ? at.getTime() < now.getTime() : undefined;
}

/** Format a per-piece dropoff group suffix. */
export function groupSuffix(group?: string | null): string {
  return group ? ` — group ${group}` : "";
}

/** A cancellation is pending only when both wire fields agree. */
export function cancellationPending(p: {
  isRemoval?: boolean | null;
  requestStatus?: string | null;
}): boolean {
  return p.isRemoval === true && p.requestStatus === "pending";
}

/** Raw pieces and projected meals share these badge fields. */
interface Badgeable {
  isConfirmed?: boolean | null;
  isLateSwappable?: boolean | null;
  isLateOrder?: boolean | null;
  isRemoval?: boolean | null;
  requestStatus?: string | null;
  cancellationPending?: boolean | null;
}

/** Format definite per-piece states as one bracketed badge; null means unreported. */
export function pieceBadges(p: Badgeable): string {
  const badges = [
    p.isConfirmed === false ? "not confirmed" : "",
    p.cancellationPending === true || cancellationPending(p) ? "cancellation requested" : "",
    p.isLateSwappable === true ? "still swappable" : "",
    p.isLateOrder === true ? "late order" : "",
  ].filter(Boolean);
  return badges.length ? ` [${badges.join(" · ")}]` : "";
}
