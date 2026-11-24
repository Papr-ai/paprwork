/**
 * Which of Your three each Needs-you item moves — the goal chip on "Also needs you" cards.
 *
 * Same Jev cascade as chat/task attribution (focusAttribution.ts): one typed `choice` per item over
 * the three goals (title + "counts as" scope) + NONE, accepted only at >= ACCEPT, else no chip.
 * A wrong chip is worse than none. Cached in memory per (goal set, item text), so a Focus repaint
 * never re-asks; only new or edited items cost a call.
 */
import { classifyItems, goalsKey, type AttributionGoal, type AttributionItem, type JevFn } from "./focusAttribution.js";

const cache = new Map<string, { goal: string | null; p: number }>();
const MAX_CACHE = 500;

export interface NeedsGoal { goalId: string; title: string; p: number }

export async function goalsForNeeds(
  goals: AttributionGoal[],
  items: AttributionItem[],
  jev?: JevFn,
): Promise<Record<string, NeedsGoal | null>> {
  const gk = goalsKey(goals);
  const ck = (it: AttributionItem) => `${gk}|${it.key}|${it.text}`;
  const todo = items.filter((it) => !cache.has(ck(it)));
  if (todo.length && goals.length) {
    const fresh = await classifyItems(goals, todo, jev ?? (await defaultJev()));
    for (const it of todo) cache.set(ck(it), fresh[it.key] ?? { goal: null, p: 0 });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  }
  const byId = new Map(goals.map((g) => [g.id, g]));
  const out: Record<string, NeedsGoal | null> = {};
  for (const it of items) {
    const a = cache.get(ck(it));
    const g = a?.goal ? byId.get(a.goal) : undefined;
    out[it.key] = g ? { goalId: g.id, title: g.title.replace(/^G\d+\s+/, ""), p: a!.p } : null;
  }
  return out;
}

async function defaultJev(): Promise<JevFn> {
  const { evaluateJevWithAuth } = await import("../../core/tools/jevAuth.js");
  return async (state, questions) => (await evaluateJevWithAuth({ state, questions, timeoutMs: 30_000 })).answers as Awaited<ReturnType<JevFn>>;
}

/** Test hook. */
export function _clearNeedsGoals(): void { cache.clear(); }
