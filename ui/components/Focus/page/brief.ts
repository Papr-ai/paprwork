/**
 * The daily brief as data: parse rows, give every item a stable id, fold reviewed items away,
 * and lift the top priority into "Do this first". Pure functions — no React, no fetch.
 *
 * Item ids use the exact hash the Home app used, so reviews saved before Focus went native
 * still match their items.
 */
import type { BriefRow, ReviewRow } from "./focusApi";

export type SectionType = "priorities" | "alerts" | "timeline" | "intel" | "tracker" | "freeform" | "reviewed";
export interface Review { status: "complete" | "irrelevant"; note?: string; at?: string }
export interface BriefItem {
  rank?: number; title?: string; why?: string; subject?: string; bullets?: string[]; source?: string;
  message?: string; action?: string; severity?: string; time?: string; tags?: string[]; detail?: Record<string, string>;
  label?: string; current?: number; target?: number; unit?: string; context?: string; task_id?: string;
  /** A priority the brief built from a teammate's ask: Focus shows that ask's reply card. */
  mention_id?: string;
  _id: string; _review: Review | null; _section: string; _type: string;
}
export interface Section { type: SectionType; title: string; items?: BriefItem[]; content?: string }
export interface Hero { date?: string; title?: string; subtitle?: string; stats?: { value: string | number; label: string }[] }
export interface Brief { hero: Hero; sections: Section[]; date: string; stale: boolean }

export const isDateKey = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export function todayKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `i${Math.abs(h)}`;
}

/** A row is a brief only with a hero title and at least one section. */
export function parseBrief(raw: string | null | undefined): { hero: Hero; sections: Omit<Section, "items">[] & { items?: unknown[] }[] } | null {
  if (!raw || typeof raw !== "string" || !raw.trim() || raw.trim() === "{}") return null;
  try {
    const b = JSON.parse(raw) as { hero?: Hero; sections?: unknown[] };
    if (!b?.hero?.title || !Array.isArray(b.sections) || !b.sections.length) return null;
    return b as never;
  } catch {
    return null;
  }
}

export function reviewMap(rows: ReviewRow[]): Record<string, Review> {
  return Object.fromEntries(rows.map((r) => [r.item_key, { status: r.status, note: r.note ?? undefined, at: r.updated_at }]));
}

/** Dates that have a real brief, newest first. */
export function briefDates(rows: BriefRow[]): string[] {
  return rows.filter((r) => isDateKey(r.date) && parseBrief(r.brief_json)).map((r) => r.date);
}

/** Ids on every item; reviewed items move to one "Reviewed" section at the end. */
export function decorate(hero: Hero, rawSections: { type: string; title: string; items?: unknown[]; content?: string }[], date: string, reviews: Record<string, Review>): Section[] {
  const reviewed: BriefItem[] = [];
  const sections = rawSections.map((s) => {
    if (!Array.isArray(s.items)) return s as Section;
    const items = s.items.map((item) => {
      const id = hashId(`${date}|${s.type}|${s.title}|${JSON.stringify(item)}`);
      return { ...(item as object), _id: id, _review: reviews[id] ?? null, _section: s.title, _type: s.type } as BriefItem;
    });
    const active = items.filter((i) => (i._review ? (reviewed.push(i), false) : true));
    return { ...s, items: active } as Section;
  }).filter((s) => s.type === "freeform" || (s.items && s.items.length));
  void hero;
  if (reviewed.length) sections.push({ type: "reviewed", title: "Reviewed", items: reviewed });
  return sections;
}

/**
 * The brief for one date. With no date (Today): today's brief, else the most recent one,
 * marked stale. Null when there is no brief at all.
 */
export function briefFor(rows: BriefRow[], reviews: Record<string, Review>, date?: string, now = new Date()): Brief | null {
  const today = todayKey(now);
  const target = date ?? today;
  let row = rows.find((r) => r.date === target && parseBrief(r.brief_json));
  if (!row && !date) row = rows.find((r) => isDateKey(r.date) && parseBrief(r.brief_json));
  const parsed = row && parseBrief(row.brief_json);
  if (!row || !parsed) return null;
  return { hero: parsed.hero, sections: decorate(parsed.hero, parsed.sections as never, row.date, reviews), date: row.date, stale: row.date !== today };
}

/** Lift the top active priority into "Do this first"; the rest are "Next actions" (today's other to-dos). */
export function pickFocus(sections: Section[]): { focus: BriefItem | null; sections: Section[] } {
  const i = sections.findIndex((s) => s.type === "priorities" && s.items?.length);
  if (i < 0) return { focus: null, sections };
  const [focus, ...rest] = sections[i].items!;
  const next = sections.slice();
  if (rest.length) next[i] = { ...sections[i], title: "Next actions", items: rest };
  else next.splice(i, 1);
  return { focus, sections: next };
}

/** The brief's own "Waiting on" section (from your notes) joins the live one, so Focus has one heading. */
export function pickWaiting(sections: Section[]): { notes: Section | null; sections: Section[] } {
  const i = sections.findIndex((s) => /^waiting\s+on\b/i.test(s.title.trim()) && s.items?.length);
  return i < 0 ? { notes: null, sections } : { notes: sections[i], sections: sections.filter((_, k) => k !== i) };
}

export const itemTitle = (i: Partial<BriefItem>) => i.title || i.subject || i.label || i.message || "this item";

export function fmtDay(d: string): string {
  return new Date(`${d}T12:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** What "Start in chat" sends for each kind of brief item. */
export function agentPrompt(i: BriefItem): string {
  switch (i._type) {
    case "timeline":
      return `Help me prepare for my ${i.time} meeting: "${i.title}".${i.detail ? ` Context: ${Object.entries(i.detail).map(([k, v]) => `${k}: ${v}`).join(". ")}` : ""} What should I know, ask, and accomplish?`;
    case "priorities":
      return `Help me execute on this priority: "${i.title}". Why it matters: ${i.why || "N/A"}. Break this down into concrete next steps I can take today.`;
    case "tracker":
      return `I'm tracking "${i.label}" — currently at ${i.current}/${i.target} ${i.unit || ""}.${i.context ? ` Context: ${i.context}` : ""} Help me close the gap and hit my target.`;
    case "intel":
      return `Brief me on: "${i.subject}". Key points: ${(i.bullets || []).join("; ")}. What else should I know? Any angles I'm missing?`;
    case "alerts":
      return `I have an alert: "${i.message}".${i.action ? ` Suggested action: ${i.action}` : ""} Help me handle this effectively right now.`;
    default:
      return `Help me with: ${itemTitle(i)}`;
  }
}
