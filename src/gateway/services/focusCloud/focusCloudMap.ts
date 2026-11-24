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

/* ---------- cloud → local, and conflict merge (pure) ---------- */

export const GOAL_KEYS = ["goalId", "title", "level", "parentId", "status", "confidence", "priority", "period", "opened", "closed",
  "nextMilestone", "owner", "evidence", "outcome", "archived", "entities"] as const;
export const TASK_KEYS = ["taskId", "title", "status", "owner", "due", "goalId", "entityRef", "source", "sourceFile", "sourceLine", "completedAt"] as const;
export const BRIEF_KEYS = ["date", "brief", "generatedBy", "reviews"] as const;

/** Only the fields we compare and send (drops rev, orgId, changeSeq, timestamps…). */
export function shape(keys: readonly string[], doc: Row): Row {
  const out: Row = {};
  for (const k of keys) out[k] = doc[k] === undefined ? null : doc[k];
  if (Array.isArray(out.entities)) out.entities = [...(out.entities as string[])].sort();
  if (out.archived != null) out.archived = !!out.archived;
  return out;
}

export function fromCloudGoal(g: Row): { row: Row; entities: string[] } {
  return {
    row: {
      id: String(g.goalId), title: g.title ?? "", level: g.level ?? "L2", parent_id: g.parentId ?? null, status: g.status ?? "proposed",
      confidence: g.confidence ?? "medium", priority: g.priority ?? 99, period: g.period ?? null, opened: g.opened ?? null, closed: g.closed ?? null,
      next_milestone: g.nextMilestone ?? null, owner: g.owner ?? null, evidence: g.evidence ?? null, outcome: g.outcome ?? null,
      archived: g.archived ? 1 : 0, source_file: g.archived ? "goals/archive.md" : "IDENTITY.md",
    },
    entities: Array.isArray(g.entities) ? (g.entities as string[]) : [],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Three-way merge after a 409. base = what we last synced, mine = local now, theirs = server now.
 * Fields only we changed win; fields only they changed win; both changed to different values → theirs wins
 * (reported in `conflicts` so the user can be told). Returns the row to send with theirs' rev.
 */
export function mergeOnConflict(base: Row | undefined, mine: Row, theirs: Row): { merged: Row; conflicts: string[] } {
  const merged: Row = { ...theirs };
  const conflicts: string[] = [];
  for (const k of Object.keys(mine)) {
    const iChanged = !base || !same(mine[k], base[k]);
    if (!iChanged) continue;
    const theyChanged = base ? !same(theirs[k], base[k]) : !same(theirs[k], mine[k]);
    if (theyChanged && !same(theirs[k], mine[k])) { if (base) conflicts.push(k); continue; }
    merged[k] = mine[k];
  }
  return { merged, conflicts };
}

/** Device-only notification settings: Do Not Disturb and sounds stay on this machine. */
export function sharedPrefs(p: Row): Row {
  const { pauseUntil: _p, ...rest } = p;
  const sources: Row = {};
  for (const [id, v] of Object.entries((p.sources ?? {}) as Record<string, Row>)) {
    const { sound: _s, ...keep } = v ?? {};
    if (Object.keys(keep).length) sources[id] = keep;
  }
  return { ...rest, sources };
}

/** Remote shared settings + this device's DND and sounds. */
export function withLocalPrefs(remote: Row, local: Row): Row {
  const sources: Record<string, Row> = { ...((remote.sources ?? {}) as Record<string, Row>) };
  for (const [id, v] of Object.entries((local.sources ?? {}) as Record<string, Row>)) {
    if (v && typeof v.sound === "boolean") sources[id] = { ...sources[id], sound: v.sound };
  }
  return { ...remote, sources, ...(local.pauseUntil ? { pauseUntil: local.pauseUntil } : {}) };
}
