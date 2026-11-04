/**
 * apps.papr.ai Focus: memory-server Focus shapes (services/focus_store_service.py, collab_service.py)
 * → the shapes the Focus page already reads from the desktop gateway (focusApi.ts). Pure, tested.
 */
export type Row = Record<string, unknown>;

const s = (v: unknown) => (v == null || v === "" ? undefined : String(v));

/** GET /api/focus/today: briefs newest first, reviews flattened (item_key → status). */
export function toToday(briefs: Row[]) {
  const reviews: Row[] = [];
  for (const b of briefs) {
    for (const r of (b.reviews as Row[] | undefined) ?? []) {
      if (r?.itemKey && (r.status === "complete" || r.status === "irrelevant")) {
        reviews.push({ item_key: String(r.itemKey), status: r.status, note: s(r.note) ?? null, updated_at: String(b.updatedAt ?? "") });
      }
    }
  }
  return {
    briefs: briefs.filter((b) => b.brief != null && typeof b.date === "string").map((b) => ({ date: String(b.date), brief_json: JSON.stringify(b.brief) })),
    reviews,
  };
}

/** One brief's reviews after a check / x (status) or undo (null). */
export function withReview(reviews: Row[] | undefined, key: string, next: Row | null): Row[] {
  const rest = (reviews ?? []).filter((r) => r?.itemKey !== key);
  return next ? [...rest, { ...next, itemKey: key }] : rest;
}

export interface WebGoal {
  id: string; title: string; status: string; level: string; confidence: string; priority: number; parent?: string;
  nextMilestone?: string; period?: string; closed?: string; outcome?: string; entities?: string[]; children?: WebGoal[];
}

/** GET /api/workspace/goals: the live tree (L1 → L2 → L3) and the archive. */
export function toGoals(docs: Row[]) {
  const all: (WebGoal & { archived: boolean })[] = docs.map((g) => ({
    id: String(g.goalId), title: String(g.title ?? ""), status: s(g.status) ?? "proposed", level: s(g.level) ?? "L2",
    confidence: s(g.confidence) ?? "medium", priority: Number(g.priority ?? 99), parent: s(g.parentId),
    nextMilestone: s(g.nextMilestone), period: s(g.period), closed: s(g.closed), outcome: s(g.outcome),
    entities: Array.isArray(g.entities) ? (g.entities as string[]) : undefined, archived: !!g.archived,
  }));
  const goals = all.filter((g) => !g.archived).map(({ archived: _a, ...g }) => g);
  const archive = all.filter((g) => g.archived).map(({ archived: _a, ...g }) => g);
  const byId = new Map(goals.map((g) => [g.id, { ...g, children: [] as WebGoal[] }]));
  const tree: WebGoal[] = [];
  const order = (a: WebGoal, b: WebGoal) => a.priority - b.priority || a.id.localeCompare(b.id);
  for (const g of [...byId.values()].sort(order)) {
    const p = g.parent ? byId.get(g.parent) : undefined;
    if (p) p.children!.push(g); else tree.push(g);
  }
  return { goals, tree, isEmpty: goals.length === 0, proposedCount: goals.filter((g) => g.status === "proposed").length, archive };
}

/** GET /api/workspace/tasks: mine and assigned to me. */
export function toTasks(docs: Row[]) {
  const tasks = docs.filter((t) => t.status !== "dropped").map((t) => ({
    id: String(t.taskId), title: String(t.title ?? ""), status: s(t.status) ?? "open", owner: s(t.owner) ?? "user",
    due: s(t.due) ?? null, goal_id: s(t.goalId) ?? null, entity_ref: s(t.entityRef) ?? null,
  }));
  return { tasks, counts: { open: tasks.filter((t) => t.status !== "done").length, done: tasks.filter((t) => t.status === "done").length } };
}

/** Your three as the desktop last scored it, with any newer web picks laid on top. */
export function toFocusState(doc: Row | null | undefined): Row | null {
  const state = doc?.state as Row | undefined;
  if (!state || !Array.isArray(state.three)) return null;
  const webNewer = doc?.picksBy === "web" && Array.isArray(doc.picks) && String(doc.picksAt ?? "") > String(state.pickedAt ?? "");
  return webNewer ? applyPicks(state, doc!.picks as Row[]) : state;
}

/** Re-order the scored goals to the picks (a goal the user wrote shows with its own title). */
export function applyPicks(state: Row, picks: Row[]): Row {
  const pool = [...((state.three as Row[]) ?? []), ...((state.candidates as Row[]) ?? [])];
  const three: Row[] = picks.slice(0, 3).map((p): Row => {
    const hit = pool.find((g) => g.id === (p.goalId ?? p.id));
    const own = { target: p.target, due: p.due, repeat: p.repeat, scope: p.scope };
    if (hit) return { ...hit, ...Object.fromEntries(Object.entries(own).filter(([, v]) => v != null)), ...(p.title ? { title: p.title, edited: true } : {}) };
    return { id: String(p.id), title: String(p.title ?? ""), origin: "custom", why: "You wrote this one", ...own };
  });
  const chosen = new Set(three.map((g) => g.id));
  return { ...state, three, candidates: pool.filter((g) => !chosen.has(g.id as string)), source: "user", confirmed: true };
}

/** Needs you + Waiting on from mentions (the web has no desktop notices or Pen drafts). */
export function toFeed(inbox: Row[], sent: Row[]) {
  const words = (m: Row) => String((m.action as Row | null)?.title ?? m.text ?? "").slice(0, 120);
  const thread = (m: Row) => (Array.isArray(m.thread) ? (m.thread as Row[]) : []);
  return {
    asks: inbox.map((m) => ({
      id: String(m.id), fromName: String(m.fromName ?? ""), title: words(m), text: String(m.text ?? ""),
      due: s((m.action as Row | null)?.due) ?? null, promisedAt: s(m.promisedAt) ?? null,
      took: m.progress === "in_progress" || (m.progress == null && !!m.reply), chatTitle: s((m.context as Row | null)?.chatTitle) ?? null,
    })),
    waiting: sent.filter((m) => m.notified !== false).map((m) => ({
      id: String(m.id), toName: String(m.toName ?? ""), title: words(m), due: s((m.action as Row | null)?.due) ?? null,
      state: m.progress === "in_progress" || (m.progress == null && m.reply) ? "in_progress" : "asked",
      reply: s((m.reply as Row | null)?.text) ?? null, replyAt: s((m.reply as Row | null)?.at) ?? null,
      mine: [...thread(m)].reverse().find((t) => t.by === "from") ?? null,
      nudgedAt: s(m.nudgedAt) ?? null, promisedAt: s(m.promisedAt) ?? null,
      chatId: s((m.context as Row | null)?.chatId) ?? null, chatTitle: s((m.context as Row | null)?.chatTitle) ?? null, at: String(m.createdAt ?? ""),
    })),
  };
}
