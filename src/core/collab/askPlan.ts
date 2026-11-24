/**
 * One plan for today: the brief's priorities with the asks Pen + Jev placed today slotted in where
 * Jev put them (before a priority, or at the end). Pure: the gateway, the desktop Focus page and the
 * web Focus page all build the plan the same way.
 */
export interface PlanEntry { key: string; title: string }
export interface PlacedAsk { id: string; title: string; triage: { before?: string; planDate?: string } }

/** Local calendar day, the same key the brief uses. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function buildPlan(priorities: { rank?: number; title?: string; mention_id?: string }[], placedAsks: PlacedAsk[], today = dayKey()): PlanEntry[] {
  const plan: PlanEntry[] = priorities.map((p, i) => ({ key: p.mention_id ? `ask:${p.mention_id}` : `rank:${p.rank ?? i + 1}`, title: String(p.title ?? "") }));
  for (const a of placedAsks) {
    if (a.triage.planDate !== today || plan.some((x) => x.key === `ask:${a.id}`)) continue;
    const at = plan.findIndex((x) => x.key === a.triage.before);
    plan.splice(at >= 0 ? at : plan.length, 0, { key: `ask:${a.id}`, title: a.title });
  }
  return plan;
}
