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

/** ISO timestamp → a compact local-ish date string (date-only when it's midnight-y). */
export function formatDate(iso?: string): string {
  if (!iso) return "";
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}
