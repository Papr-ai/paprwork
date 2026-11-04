/** Formatting shared by the Focus page. Same output as the Home app (three.js, tasks.js, three_track.js). */
import type { FocusGoal, Signals } from "./focusApi";

const asDate = (due: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00` : due);

export function fmtDue(due?: string): string {
  if (!due) return "";
  const d = asDate(due);
  return Number.isNaN(d.getTime()) ? `by ${due}` : `by ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function daysLeft(due?: string): number | null {
  const d = due ? asDate(due) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((d.getTime() - new Date().setHours(12, 0, 0, 0)) / 86400000));
}

export const hours = (h?: number) =>
  !h ? "0h" : h >= 10 ? `${Math.round(h)}h` : h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.max(1, Math.round(h * 60))}m`;

export const every = (g: Pick<FocusGoal, "repeat">) => (g.repeat === "daily" ? "Every day" : g.repeat === "weekly" ? "Every week" : "");

export function goalSub(g: FocusGoal): string {
  const when = g.repeat ? every(g) : fmtDue(g.due);
  return [g.target, when].filter(Boolean).join(" · ") || (g.nextStep ? `Next: ${g.nextStep}` : "");
}

/** Moved = real time went in this week; touched = a little; none = the goal sat still. */
export function pace(s: Signals = {}): [string, string] {
  return (s.hours7 ?? 0) >= 1 ? ["on", "Moved"] : (s.hours7 ?? 0) > 0 || s.logDays ? ["risk", "Barely touched"] : ["off", "No time"];
}

/** Short name for task chips: "Tranche 2" rather than "G1". Null when the goal isn't one of the three. */
export function goalLabel(three: FocusGoal[], goalId: string | null | undefined): string | null {
  const g = goalId ? three.find((x) => x.id === goalId) : undefined;
  if (!g) return null;
  const words = g.title
    .replace(/^(close|ship|land|grow|fix|validate|prevent|build|launch|finish|get|make|reach|hit)\s+/i, "")
    .split(/\s+(?:and|for|on|with|via|to|in|by|\+|&)\s+/i)[0]
    .split(/\s+/)
    .filter((w, i, all) => !(i < all.length - 1 && /^(a|an|the|our|my|validated|new)$/i.test(w)));
  return words.slice(0, 3).join(" ");
}

export function num(n: number | null | undefined): string {
  if (n == null) return "—";
  const k = (d: number) => `${(n / 1000).toFixed(d).replace(/\.0$/, "")}k`;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e5 ? k(0) : n >= 1000 ? k(1) : String(n);
}

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** Task due: "Due today", "Overdue · Nov 2", "Due Nov 9". */
export function taskDue(due: string | null): string {
  if (!due) return "";
  const d = new Date(`${due}T12:00`);
  if (Number.isNaN(d.getTime())) return due;
  const days = Math.round((d.getTime() - new Date().setHours(12, 0, 0, 0)) / 86400000);
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : days < 0 ? `Overdue · ${md}` : `Due ${md}`;
}
