/**
 * "I'll have the copy ready Thursday morning" → the date both sides track.
 * Pure (no I/O): parsed on the replier's machine in their local time, sent to the server as ISO.
 * Only reads what people actually say: a day (today, tomorrow, a weekday, EOD/EOW) and an optional
 * time or part of day. Anything vaguer ("soon", "next sprint") → null, and we show no date.
 */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PARTS: Record<string, number> = { morning: 9, noon: 12, lunch: 12, afternoon: 14, evening: 18, tonight: 20, eod: 17, "end of day": 17, cob: 17 };

function dayOffset(t: string, now: Date): number | null {
  if (/\b(today|tonight|eod|end of (the )?day|cob|this (morning|afternoon|evening))\b/.test(t)) return 0;
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return 1;
  if (/\b(eow|end of (the )?week)\b/.test(t)) return (5 - now.getDay() + 7) % 7;
  const m = t.match(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?\b/);
  if (!m) return null;
  const idx = DAYS.findIndex((d) => d.startsWith(m[1]));
  const off = (idx - now.getDay() + 7) % 7;
  return /\bnext\s+$/.test(t.slice(0, m.index)) ? off + 7 : off; // "next Thu" = the one after
}

function hourOf(t: string): { h: number; min: number } | null {
  const clock = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\b(?:at|by)\s+(\d{1,2}):(\d{2})\b/);
  if (clock) {
    let h = +clock[1] % 12;
    if (clock[3] === "pm" || (!clock[3] && h < 8)) h += 12;
    if (!clock[3] && +clock[1] >= 12) h = +clock[1];
    return { h, min: clock[2] ? +clock[2] : 0 };
  }
  const part = Object.keys(PARTS).find((k) => new RegExp(`\\b${k}\\b`).test(t));
  return part ? { h: PARTS[part], min: 0 } : null;
}

/** The moment they promised, or null. Defaults to 5pm when only a day is given. Never in the past. */
export function parsePromise(text: string, now = new Date()): Date | null {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "")} `;
  const off = dayOffset(t, now);
  const time = hourOf(t);
  if (off == null && !time) return null;
  const d = new Date(now);
  d.setDate(d.getDate() + (off ?? 0));
  d.setHours(time?.h ?? 17, time?.min ?? 0, 0, 0);
  if (d <= now) {
    if (off == null) d.setDate(d.getDate() + 1); // "by 9am" said at 10am = tomorrow 9am
    else if (off === 0 && !/\b(today|tonight|eod|cob)\b/.test(t)) d.setDate(d.getDate() + 7); // "Thursday" said on Thursday evening
    else return null;
  }
  return d;
}

/** "today 5pm", "tomorrow 9am", "Thu 9am", "Nov 12 2pm". */
export function promiseLabel(iso: string | Date, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const h = d.getHours() % 12 || 12;
  const time = `${h}${d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, "0")}` : ""}${d.getHours() < 12 ? "am" : "pm"}`;
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7
    ? d.toLocaleDateString("en-US", { weekday: "short" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day} ${time}`;
}

/** An ask's due date ("2026-11-06") in words: "today", "tomorrow", "Fri", "Nov 12". Anything else passes through. */
export function dueLabel(due: string | null | undefined, now = new Date()): string {
  if (!due) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim().slice(0, 10));
  if (!m) return due;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((d.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** For text that's stored (chat messages, Pen's context): a date that never goes stale, "Thu, Nov 5". */
export function dueDate(due: string | null | undefined): string {
  if (!due) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim().slice(0, 10));
  if (!m) return due;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
