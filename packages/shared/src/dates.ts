/** Local calendar arithmetic avoids date-only UTC parsing. */
export function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA");
}
export function addDaysLocal(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00`);
  value.setDate(value.getDate() + days);
  return value.toLocaleDateString("en-CA");
}
/** The round trip rejects impossible dates that Date would otherwise normalize. */
export const isCalendarDate = (date: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && addDaysLocal(date, 0) === date;
