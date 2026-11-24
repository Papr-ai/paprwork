/**
 * Asks to you, as Focus shows them: Pen's draft and check, Jev's ranking (when, goal, why), and one
 * plan for today (the brief's priorities with the asks Jev placed today). Pure: desktop and web share it.
 */
import { buildPlan } from "../../../../src/core/collab/askPlan";
import type { BriefItem, Section } from "./brief";

export type AskWhen = "now" | "today" | "this_week" | "fyi";
export interface FeedAsk {
  id: string; key: string; fromName: string; title: string; text: string; due: string | null; took: boolean;
  draft: string; findings?: string; chatId?: string | null; at: string;
  when: AskWhen | null; why?: string; goal?: string; placed: boolean; before?: string; planDate?: string;
}
export type PlanItem = { kind: "brief"; item: BriefItem } | { kind: "ask"; ask: FeedAsk };

export const WHEN_LABEL: Record<AskWhen, string> = { now: "Now", today: "Today", this_week: "This week", fyi: "FYI" };
const WHENS = new Set(Object.keys(WHEN_LABEL));
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
type Row = Record<string, unknown>;

/** A server mention row (desktop collab:asks, or the web feed) → what Focus renders. */
export function toFeedAsk(m: Row): FeedAsk {
  const t = (m.triage ?? null) as Row | null;
  const action = (m.action ?? null) as Row | null;
  const when = t && WHENS.has(String(t.when)) ? (t.when as AskWhen) : null;
  return {
    id: String(m.id), key: `mention:${String(m.id)}`, fromName: String(m.fromName ?? ""),
    title: str(m.title) ?? str(action?.title) ?? String(m.text ?? "").slice(0, 120), text: String(m.text ?? ""),
    due: str(m.due) ?? str(action?.due) ?? null,
    took: typeof m.took === "boolean" ? m.took : m.progress === "in_progress" || (m.progress == null && !!m.reply),
    draft: str(m.draft) ?? "", findings: str(m.findings), chatId: str(m.chatId) ?? null, at: String(m.at ?? m.createdAt ?? ""),
    when, why: str(t?.why), goal: str(t?.goalTitle)?.replace(/^G\d+\s+/, ""),
    placed: !!t?.placed, before: str(t?.before), planDate: str(t?.planDate),
  };
}

/** The brief's priorities, out of its sections: Focus draws them as the one plan instead. */
export function pickPlan(sections: Section[]): { priorities: BriefItem[]; sections: Section[] } {
  const i = sections.findIndex((s) => s.type === "priorities");
  return i < 0 ? { priorities: [], sections } : { priorities: sections[i].items ?? [], sections: sections.filter((_, k) => k !== i) };
}

/** Today's one plan. A brief item made from an ask that's since been answered drops out. */
export function onePlan(priorities: BriefItem[], asks: FeedAsk[], today: string): PlanItem[] {
  const byId = new Map(asks.map((a) => [a.id, a]));
  const byKey = new Map(priorities.map((p, i) => [p.mention_id ? `ask:${p.mention_id}` : `rank:${p.rank ?? i + 1}`, p]));
  const placed = asks.filter((a) => a.placed).map((a) => ({ id: a.id, title: a.title, triage: { before: a.before, planDate: a.planDate } }));
  const entries = buildPlan(priorities.map((p) => ({ rank: p.rank, title: p.title, mention_id: p.mention_id })), placed, today);
  return entries.flatMap((e): PlanItem[] => {
    if (e.key.startsWith("ask:")) { const a = byId.get(e.key.slice(4)); return a ? [{ kind: "ask", ask: a }] : []; }
    const p = byKey.get(e.key);
    return p ? [{ kind: "brief", item: p }] : [];
  });
}

/** Asks that aren't in today's plan: All tasks lists them; Today shows a count. */
export const unplanned = (asks: FeedAsk[], plan: PlanItem[]) => {
  const inPlan = new Set(plan.flatMap((p) => (p.kind === "ask" ? [p.ask.id] : [])));
  return asks.filter((a) => !inPlan.has(a.id));
};
