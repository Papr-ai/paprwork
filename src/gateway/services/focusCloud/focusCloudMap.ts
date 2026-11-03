/** Home SQLite rows → the memory server's Focus shapes (services/focus_store_service.py). Pure. */
export type Row = Record<string, unknown>;

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const n = (v: unknown) => (v == null || v === "" ? null : Number(v));

export function toCloudGoal(g: Row, links: Row[] = []) {
  const id = String(g.id);
  return {
    goalId: id, title: String(g.title ?? ""), level: s(g.level), parentId: s(g.parent_id), status: s(g.status),
    confidence: s(g.confidence), priority: n(g.priority) ?? 99, period: s(g.period), opened: s(g.opened), closed: s(g.closed),
    nextMilestone: s(g.next_milestone), owner: s(g.owner), evidence: s(g.evidence), outcome: s(g.outcome),
    archived: Number(g.archived ?? 0) === 1,
    entities: links.filter((l) => String(l.goal_id) === id).map((l) => String(l.entity_ref)).sort(),
  };
}

export function toCloudTask(t: Row) {
  return {
    taskId: String(t.id), title: String(t.title ?? ""), status: s(t.status) ?? "open", owner: s(t.owner), due: s(t.due),
    goalId: s(t.goal_id), entityRef: s(t.entity_ref), source: s(t.source), sourceFile: s(t.source_file),
    sourceLine: n(t.source_line), completedAt: s(t.completed_at),
  };
}

export function toCloudBrief(b: Row, reviews: Row[] = []) {
  const date = String(b.date);
  let brief: unknown = null;
  try { brief = JSON.parse(String(b.brief_json ?? "null")); } catch { brief = { raw: String(b.brief_json ?? "") }; }
  return {
    date, brief, generatedBy: "papr-work",
    reviews: reviews.filter((r) => String(r.brief_date) === date).map((r) => ({
      itemKey: r.item_key, section: r.section, itemType: r.item_type, title: r.title, status: r.status, note: s(r.note), taskId: s(r.task_id),
    })),
  };
}
