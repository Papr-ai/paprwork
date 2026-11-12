/**
 * Pen checks an ask, Jev ranks it, and confident ones go into today's plan.
 *
 *   Pen (investigate in mentions.ts) verifies the ask read-only and writes findings + a one-line why.
 *   Jev answers three typed questions per ask, against your priority goals and today's plan:
 *     when  — now | today | this_week | fyi
 *     goal  — which priority goal it moves (or NONE)
 *     slot  — where it goes in today's plan: before item 1, 2, 3…, at the end, or not today
 *   Code only applies the answers: an ask joins today's plan when Jev is confident it's now/today
 *   AND confident about the slot (>= PLACE). Unsure asks still show in All tasks with their draft.
 *
 * Asks that land together are ranked in one Jev call (QUEUE_MS debounce, up to BATCH per call).
 * The ranking is saved on the ask on the server (POST /mentions/{id}/triage), so the web and every
 * device show the same plan. No Jev (signed out, offline) → no ranking; nothing is guessed.
 */
import type { MentionItem } from "./mentions.js";

export const PLACE = 0.6;
export const WHEN = ["now", "today", "this_week", "fyi"] as const;
export type When = (typeof WHEN)[number];
const NONE = "NONE";
const NOT_TODAY = "not_today";
const BATCH = 6;
const QUEUE_MS = 3_000;

export interface PlanEntry { key: string; title: string }
export interface TriageGoal { id: string; title: string; scope?: string }
export interface AskInput { item: MentionItem; findings?: string; why?: string }
export interface Triage {
  when: When; p: number; goalId?: string; goalTitle?: string; goalP?: number; why?: string;
  placed: boolean; before?: string; placeP?: number; planDate: string;
}
interface Answer { choice?: string; confidence?: number; probabilities?: Record<string, number> }
export type TriageJev = (state: string, questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>) => Promise<Record<string, Answer>>;

/** Local calendar day, the same key the brief uses. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function best(a: Answer | undefined): { choice: string | null; p: number } {
  if (!a) return { choice: null, p: 0 };
  const probs = a.probabilities ?? {};
  let choice = a.choice ?? null, p = a.confidence ?? (choice ? probs[choice] ?? 0 : 0);
  for (const [k, v] of Object.entries(probs)) if (v > p) { choice = k; p = v; }
  return { choice, p: Math.round(p * 100) / 100 };
}

function askText(a: AskInput, n: number): string {
  const it = a.item;
  return [
    `#${n} ${it.fromName} asked: ${it.text.replace(/\s+/g, " ").slice(0, 600)}`,
    it.action ? `   Action: ${it.action.title}${it.action.due ? ` (due ${it.action.due})` : ""}${it.action.blocks ? `; blocks: ${it.action.blocks}` : ""}` : "",
    a.findings ? `   Pen checked: ${a.findings.slice(0, 500)}` : "   Pen checked: (not verified)",
    a.why ? `   Pen's read: ${a.why.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");
}

/** One Jev call for a batch of asks. Pure apart from `jev`. */
export async function rankAsks(asks: AskInput[], goals: TriageGoal[], plan: PlanEntry[], jev: TriageJev, today = dayKey()): Promise<Record<string, Triage>> {
  const goalCriteria: Record<string, string> = Object.fromEntries(goals.map((g) => [g.id, `${g.title}${g.scope ? `. Counts: ${g.scope}` : ""}`]));
  goalCriteria[NONE] = "Doesn't move any of these goals";
  const slots: Record<string, string> = Object.fromEntries(plan.map((p, i) => [`before_${i + 1}`, `More important today than plan item ${i + 1} (${p.title.slice(0, 120)})`]));
  slots.end = plan.length ? "Should be done today, after everything already in the plan" : "Should be done today";
  slots[NOT_TODAY] = "Not today: can wait, or the plan matters more";
  const state = [
    goals.length ? `Priority goals:\n${goals.map((g) => `- ${g.id}: ${g.title}`).join("\n")}` : "No priority goals set.",
    plan.length ? `Today's plan, in order:\n${plan.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}` : "Today's plan is empty.",
    `Asks from teammates:\n${asks.map((a, i) => askText(a, i + 1)).join("\n")}`,
  ].join("\n\n");
  const questions: Parameters<TriageJev>[1] = {};
  asks.forEach((_, i) => {
    const n = i + 1;
    questions[`when_${n}`] = { type: "choice", instructions: `When should the user act on ask #${n}?`, criteria: {
      now: "Someone is blocked right now, or it is due within hours", today: "Should be done today",
      this_week: "Matters but can wait a few days", fyi: "No action needed from the user" } };
    if (goals.length) questions[`goal_${n}`] = { type: "choice", instructions: `Which priority goal does doing ask #${n} move forward? NONE if it serves no goal.`, criteria: goalCriteria };
    questions[`slot_${n}`] = { type: "choice", instructions: `Where does ask #${n} belong in today's plan?`, criteria: slots };
  });
  const answers = await jev(state, questions);
  const out: Record<string, Triage> = {};
  asks.forEach((a, i) => {
    const n = i + 1;
    const w = best(answers[`when_${n}`]);
    if (!w.choice || !(WHEN as readonly string[]).includes(w.choice)) return;
    const g = best(answers[`goal_${n}`]);
    const goal = g.choice && g.choice !== NONE && g.p >= PLACE ? goals.find((x) => x.id === g.choice) : undefined;
    const s = best(answers[`slot_${n}`]);
    const soon = (w.choice === "now" || w.choice === "today") && w.p >= PLACE;
    const placed = soon && !!s.choice && s.choice !== NOT_TODAY && s.p >= PLACE;
    const idx = placed && s.choice!.startsWith("before_") ? Number(s.choice!.slice(7)) - 1 : -1;
    out[a.item.id] = {
      when: w.choice as When, p: w.p, ...(goal ? { goalId: goal.id, goalTitle: goal.title, goalP: g.p } : {}),
      ...(a.why ? { why: a.why.slice(0, 300) } : {}), placed, placeP: s.p, planDate: today,
      ...(placed ? { before: idx >= 0 && plan[idx] ? plan[idx].key : "end" } : {}),
    };
  });
  return out;
}

/** Today's plan: the brief's priorities, with asks already placed today slotted in. */
export function buildPlan(priorities: { rank?: number; title?: string; mention_id?: string }[], placedAsks: { id: string; title: string; triage: Pick<Triage, "before" | "planDate"> }[], today = dayKey()): PlanEntry[] {
  const plan: PlanEntry[] = priorities.map((p, i) => ({ key: p.mention_id ? `ask:${p.mention_id}` : `rank:${p.rank ?? i + 1}`, title: String(p.title ?? "") }));
  for (const a of placedAsks) {
    if (a.triage.planDate !== today || plan.some((x) => x.key === `ask:${a.id}`)) continue;
    const at = plan.findIndex((x) => x.key === a.triage.before);
    plan.splice(at >= 0 ? at : plan.length, 0, { key: `ask:${a.id}`, title: a.title });
  }
  return plan;
}

// ── Runtime: queue, gather context, save ────────────────────────────────────

let queue: AskInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Rank an ask after Pen checked it. Batched; never throws. */
export function queueTriage(a: AskInput, onDone?: (t: Triage | null) => void): void {
  queue.push(a);
  waiters.set(a.item.id, onDone);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), QUEUE_MS);
}
const waiters = new Map<string, ((t: Triage | null) => void) | undefined>();

async function flush(): Promise<void> {
  timer = null;
  const batch = queue.splice(0, BATCH);
  if (queue.length) timer = setTimeout(() => void flush(), 0);
  let ranked: Record<string, Triage> = {};
  try {
    const [goals, plan] = await Promise.all([priorityGoals(), todaysPlan()]);
    ranked = await rankAsks(batch, goals, plan, await defaultJev());
    const { saveTriage } = await import("./mentions.js");
    await Promise.all(Object.entries(ranked).map(([id, t]) => saveTriage(id, t).catch(() => undefined)));
  } catch { /* no Jev or offline: leave unranked */ }
  for (const a of batch) { waiters.get(a.item.id)?.(ranked[a.item.id] ?? null); waiters.delete(a.item.id); }
}

async function priorityGoals(): Promise<TriageGoal[]> {
  const { getFocus } = await import("../focusGoals.js");
  return (await getFocus()).three.map((g) => ({ id: g.id, title: g.title.replace(/^G\d+\s+/, ""), scope: g.scope ?? g.target ?? undefined }));
}

export async function todaysPlan(today = dayKey()): Promise<PlanEntry[]> {
  const { focusQuery } = await import("../focusDb.js");
  const row = (await focusQuery("SELECT brief_json FROM briefs WHERE date = ?", [today]).catch(() => []))[0];
  let priorities: { rank?: number; title?: string; mention_id?: string }[] = [];
  try {
    const b = JSON.parse(String(row?.brief_json ?? "null")) as { sections?: { type?: string; items?: typeof priorities }[] } | null;
    priorities = b?.sections?.find((s) => s.type === "priorities")?.items ?? [];
  } catch { /* no brief yet */ }
  const { listMentions } = await import("./mentions.js");
  const org = process.env.PAPR_ORG_ID;
  const asks = (await listMentions("inbox", "open").catch(() => [] as MentionItem[]))
    .filter((m) => (!m.orgId || !org || m.orgId === org) && m.triage?.placed)
    .sort((a, b) => String(a.triage!.at ?? "").localeCompare(String(b.triage!.at ?? "")))
    .map((m) => ({ id: m.id, title: `${m.fromName.split(" ")[0]}: ${m.action?.title ?? m.text.slice(0, 100)}`, triage: m.triage! }));
  return buildPlan(priorities, asks, today);
}

async function defaultJev(): Promise<TriageJev> {
  const { evaluateJevWithAuth } = await import("../../../core/tools/jevAuth.js");
  return async (state, questions) => (await evaluateJevWithAuth({ state, questions, timeoutMs: 30_000 })).answers as Awaited<ReturnType<TriageJev>>;
}
