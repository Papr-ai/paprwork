import { getModelById } from "../../../constants/models";

export function usd(n: number): string {
  if (n >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 100) return "$" + Math.round(n);
  return "$" + n.toFixed(2);
}

export function tok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

export function pct(a: number, b: number): number {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

export function modelName(id: string | null): string {
  if (!id) return "Unknown model";
  return getModelById(id)?.name ?? id;
}

export function ago(iso: string, now = Date.now()): string {
  const h = Math.max(0, (now - Date.parse(iso)) / 3.6e6);
  if (h < 1) return "just now";
  if (h < 24) return Math.round(h) + "h ago";
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d + "d ago";
}

export function chatTitle(t: string): string {
  const clean = (t || "").replace(/\.\.\.$/, "").trim();
  return !clean || clean === "New Chat" ? "Untitled chat" : clean;
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function clock(h: number, m: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Plain-English cadence for a job schedule; falls back to the raw cron. */
export function scheduleLabel(s: { cron?: string; intervalMs?: number; atTime?: string } | undefined): string {
  if (!s) return "Manual";
  if (s.intervalMs) {
    const min = Math.round(s.intervalMs / 60000);
    if (min < 60) return `Every ${min} min`;
    const h = Math.round(min / 60);
    return h === 1 ? "Hourly" : h === 24 ? "Daily" : `Every ${h} hours`;
  }
  if (s.atTime) return `Once · ${new Date(s.atTime).toLocaleString()}`;
  if (!s.cron) return "Manual";
  const [mi, hr, dom, mon, dow] = s.cron.trim().split(/\s+/);
  if (dom !== "*" || mon !== "*") return s.cron;
  if (/^\d+$/.test(mi) && hr === "*" && dow === "*") return "Hourly";
  const range = hr?.match(/^(\d+)-(\d+)$/);
  if (/^\d+$/.test(mi) && range) {
    const days = dow === "1-5" ? "weekdays " : dow === "*" ? "" : null;
    if (days !== null) return `Hourly · ${days}${+range[1] % 12 || 12}–${+range[2] % 12 || 12}`;
  }
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(hr)) return s.cron;
  const at = clock(+hr, +mi);
  if (dow === "*") return `Daily · ${at}`;
  if (dow === "1-5") return `Weekdays · ${at}`;
  if (/^[0-6]$/.test(dow)) return `${DAYS[+dow]} · ${at}`;
  return s.cron;
}
