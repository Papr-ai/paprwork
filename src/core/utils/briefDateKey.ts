/**
 * Calendar date keys for Daily Brief rows (YYYY-MM-DD).
 * Uses local system timezone — matches `date +%Y-%m-%d` in job bash and the user's "today".
 */

export function formatBriefDateKey(date: Date, timeZone?: string): string {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today's brief row key in local time (or optional IANA timezone for scheduled/cloud runs). */
export function todayBriefDateKey(timeZone?: string): string {
  return formatBriefDateKey(new Date(), timeZone);
}
