// Formatters.

/**
 * Money → "$12.34", from DOLLARS. Units are MIXED on the wire: everything we render is dollars
 * (item/option/piece price, copayAmount, userReceipt.*), but `Order.total`/`serviceFee`/`tally` are
 * cents. Those are left unselected, so nothing cents-valued reaches here. See CLAUDE.md.
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
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Parse a Forkable timestamp to a real instant, for comparing against the clock.
 *
 * Handles the floating-local family only: `forDeliveryAt`'s "…T12:01:00.000Z" means noon local, so
 * `new Date()` alone would shift it. Timestamps with a true offset need nothing, and honest-UTC ones
 * (`dropoffCompletedAt`) must go through `formatInstantLike` instead. CLAUDE.md lists which is which
 * — a `Z` alone can't tell you, so it's knowledge, not inference.
 *
 * Two nudges on top of `Date`, whose offset-less parsing is already local: drop a lying `Z`, and pin
 * a time onto a date-only string, since those parse as UTC.
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
 * Shown in the offset Forkable sent, which is also the least work: the leading "YYYY-MM-DDTHH:MM"
 * already *is* the wall clock to display — true both for a real offset and for `forDeliveryAt`'s
 * mislabelled `Z` — so this is pure string slicing, with no `Date` and no host-zone dependence.
 */
export function formatDateTime(iso?: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso ?? "");
  if (!m) return formatDay(iso);
  const [, date, hh, mm] = m;
  const h = Number(hh);
  return `${weekdayOf(date)} ${date} ${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** Parse an honest-UTC instant. `undefined` unless it really carries a `Z`. */
function utcInstant(utcIso?: string): Date | undefined {
  // `new Date`, NOT parseFloating: this `Z` is honest, and parseFloating would strip it and reread
  // the value as host-local — the floating-local rule, which is wrong for this family.
  return utcIso && /Z$/i.test(utcIso) ? valid(new Date(utcIso)) : undefined;
}

/**
 * Show an honest-UTC instant as a wall clock in a named IANA zone:
 * `formatInstantIn(dropoffCompletedAt, "America/Los_Angeles", "PT")` → "Tue 2026-08-11 11:41 AM PT".
 *
 * Honest-UTC fields only — never `forDeliveryAt`. `""` when the instant or zone is missing: an
 * omitted line beats a wrong clock.
 *
 * Host-independent because the zone is explicit; `formatToParts` (not `toLocaleString`) so the shape
 * is ours rather than the locale's. Don't drop the explicit `timeZone` — without it this silently
 * becomes host-dependent, which the TZ test run exists to catch.
 */
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

/**
 * Same, for clubs that expose no IANA zone: borrow the offset off a sibling timestamp that carries a
 * real one (`etaStatus.start`). Prefer `formatInstantIn`; this is the fallback.
 */
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
 * Time left until an instant, as "2h 14m" / "14m". `""` when the value is missing, unreadable, or
 * already past — an expired countdown is not news, it's just closed.
 *
 * Used for `order.replacementCutoffTs`, whose timestamp family is UNPROVEN: it reads null on every
 * delivery observed, so there is nothing to measure. The app does `DateTime.fromISO(ts).diffNow()`,
 * i.e. treats it as a real instant and honours a `Z`, and this follows the app — hence `new Date`
 * rather than `parseFloating`, which would strip a `Z` and reread it as host-local. Callers keep the
 * raw ISO alongside so the reading can be redone if this turns out wrong.
 *
 * That reading REQUIRES an explicit `Z` or `±HH:MM`, the same discipline as `utcInstant`. An
 * offset-less value has no instant to count down to: `new Date` would read it as host-local, so the
 * identical wire value would produce "2h 14m" on one host and "" on another. Since the family is
 * unproven, an unexpected format must omit the line rather than invent a clock — and `bun run
 * test:tz` could never catch it, because every fixture we can write carries an offset.
 *
 * Rounds UP, so a window with 30 seconds left reads "1m" rather than vanishing.
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

/**
 * The dropoff group as a trailing segment: `" — group A1"`, or `""` before the delivery is grouped.
 * Every renderer goes through this so the list and the status view can't drift apart — the group is
 * per PIECE, so it attaches to a dish, and the em dash separates a dish's attributes while a comma
 * separates the dishes themselves.
 */
export function groupSuffix(group?: string | null): string {
  return group ? ` — group ${group}` : "";
}

/**
 * A cancellation was requested for this meal and Forkable hasn't acted on it yet. Two fields have to
 * agree, so the fold lives here and every caller reuses it rather than re-deriving the pair.
 */
export function cancellationPending(p: {
  isRemoval?: boolean | null;
  requestStatus?: string | null;
}): boolean {
  return p.isRemoval === true && p.requestStatus === "pending";
}

/**
 * The per-piece state a badge can report. Structural, so this module needs no domain imports, and
 * deliberately accepting both shapes: a raw `Piece` (the `isRemoval`/`requestStatus` pair) and a
 * view model that already folded them into `cancellationPending`.
 */
interface Badgeable {
  isConfirmed?: boolean | null;
  isLateSwappable?: boolean | null;
  isLateOrder?: boolean | null;
  isRemoval?: boolean | null;
  requestStatus?: string | null;
  cancellationPending?: boolean | null;
}

/**
 * Per-meal state as ONE bracketed group, ordered the way a member cares: whether the meal is
 * happening at all, then what they can still do about it.
 *
 * Bracketed, and `·`-separated inside, because the em dash is already the structural separator for a
 * dish's parts — stacking states onto it made "dish — venue — group — state — state" one flat run
 * with no way to see where the facts ended and the state began. The bracket also survives the list's
 * comma-joined dishes: "A [state], B [state]" stays readable where the dashes didn't.
 *
 * Shared by the list and the status view so neither spells these differently. Every clause tests a
 * definite value rather than falsiness — these fields are nullable, and `null` means "not reported",
 * which must render nothing rather than "not confirmed". The consequence of `not confirmed` is a
 * footnote at the bottom of the status view, not more words here.
 */
export function pieceBadges(p: Badgeable): string {
  const badges = [
    p.isConfirmed === false ? "not confirmed" : "",
    p.cancellationPending === true || cancellationPending(p) ? "cancellation requested" : "",
    p.isLateSwappable === true ? "still swappable" : "",
    p.isLateOrder === true ? "late order" : "",
  ].filter(Boolean);
  return badges.length ? ` [${badges.join(" · ")}]` : "";
}
