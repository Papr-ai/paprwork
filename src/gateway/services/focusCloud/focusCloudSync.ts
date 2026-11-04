/**
 * Focus data lives in Mongo (/v1/cloud/collab/focus/*). Each device keeps a local copy in the Focus DB (focusDb.ts)
 * so the app is fast and works offline; IDENTITY.md goal blocks are generated from it.
 *
 * One cycle = pull, then push:
 *  - Pull: GET /focus/changes?since=<cursor> (full snapshot the first time). A remote change is applied
 *    locally unless we have an unsent local edit to the same item (the push sorts that out).
 *  - Push: anything whose local copy differs from the last synced copy (`base`) is PUT with base.rev.
 *    409 = changed on another device: three-way merge (fields only we changed win; same field on both
 *    sides → theirs, and you get a notice), PUT again with their rev, apply the result locally.
 * Cycles run after local writes (debounced), on focus.changed events from the feed, and at boot.
 * Never throws: signed out, offline or an older server skips and the next cycle retries.
 */
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { cloudActingUserId } from "../../utils/cloudActingUser.js";
import { focusDb } from "../focusDb.js";
import {
  BRIEF_KEYS, GOAL_KEYS, TASK_KEYS, fromCloudGoal, mergeOnConflict, shape, sharedPrefs, toCloudBrief, toCloudGoal, toCloudTask,
  withLocalPrefs, type Row,
} from "./focusCloudMap.js";

const BRIEF_DAYS = 14;

interface Base { rev?: number; key?: string; data: Row }
interface State { v: 2; deviceId: string; cursor?: string; base: Record<string, Base> }

const home = (endpoint: "query" | "write", sql: string, params: unknown[] = []): Promise<Row[]> => focusDb(endpoint, sql, params);
const q = (sql: string, params: unknown[] = []) => home("query", sql, params).catch(() => [] as Row[]);

async function stateFile(): Promise<string> {
  const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
  return path.join(getPaprRoot(), "data", "focus-cloud-sync.json");
}
async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(readFileSync(await stateFile(), "utf8")) as State;
    if (s.v === 2) return s;
  } catch { /* first run */ }
  return { v: 2, deviceId: randomUUID(), base: {} };
}
async function saveState(s: State): Promise<void> {
  const f = await stateFile();
  try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s)); } catch { /* next cycle retries */ }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Resp = { status: number; ok: boolean; json: Row };
async function call(p: string, method: "GET" | "PUT" | "POST", body?: unknown): Promise<Resp> {
  const res = await cloudApiFetch(`/v1/cloud/collab${p}`, { method, body, timeoutMs: 20_000 });
  const json = (await res.json().catch(() => ({}))) as Row;
  return { status: res.status, ok: res.ok, json };
}
class Skip extends Error {}
const must = (r: Resp, what: string) => {
  if (r.status === 404 || r.status === 501) throw new Skip("server has no Focus store yet");
  if (!r.ok && r.status !== 409) throw new Error(`${what} ${r.status}: ${JSON.stringify(r.json).slice(0, 160)}`);
  return r;
};

/* ---------- local snapshot, keyed like base ---------- */

async function localItems(): Promise<Map<string, { kind: string; data: Row }>> {
  const out = new Map<string, { kind: string; data: Row }>();
  const links = await q("SELECT goal_id, entity_ref FROM goal_entities WHERE source IN ('goal','both')");
  for (const g of await q("SELECT * FROM goals")) out.set(`goal:${g.id}`, { kind: "goal", data: shape(GOAL_KEYS, toCloudGoal(g, links)) });
  for (const t of await q("SELECT * FROM tasks")) out.set(`task:${t.id}`, { kind: "task", data: shape(TASK_KEYS, toCloudTask(t)) });
  const since = new Date(Date.now() - BRIEF_DAYS * 86_400_000).toISOString().slice(0, 10);
  const reviews = await q("SELECT * FROM brief_reviews WHERE brief_date >= ?", [since]);
  for (const b of await q("SELECT date, brief_json FROM briefs WHERE date >= ?", [since])) {
    out.set(`brief:${b.date}`, { kind: "brief", data: shape(BRIEF_KEYS, toCloudBrief(b, reviews)) });
  }
  const { getNoticeService } = await import("../notifications/NoticeService.js");
  out.set("prefs", { kind: "prefs", data: sharedPrefs(getNoticeService().prefs as unknown as Row) });
  return out;
}

/* ---------- apply a remote copy locally ---------- */

async function applyLocal(kind: string, doc: Row, me?: string): Promise<void> {
  if (kind === "goal") {
    const { applyRemoteGoal } = await import("../goalsStore.js");
    const { row, entities } = fromCloudGoal(doc);
    await applyRemoteGoal(row, entities);
  } else if (kind === "task") {
    const id = localTaskId(doc, me);
    const cur = (await q("SELECT * FROM tasks WHERE id = ?", [id]))[0];
    const done = doc.status === "done";
    if (cur && (cur.source === "open-item" || cur.source === "l3-goal")) {
      if ((cur.status === "done") !== done) {
        const { setTaskDone } = await import("../workspaceTasks.js");
        await setTaskDone(id, done);
      }
      return;
    }
    const now = new Date().toISOString();
    await home("write", `INSERT INTO tasks (id, title, status, owner, due, goal_id, entity_ref, source, source_file, source_line, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'cloud', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, owner=excluded.owner, due=excluded.due, goal_id=excluded.goal_id,
        entity_ref=excluded.entity_ref, updated_at=excluded.updated_at, completed_at=excluded.completed_at`,
    [id, doc.title ?? "", doc.status ?? "open", doc.owner ?? "user", doc.due ?? null, doc.goalId ?? null, doc.entityRef ?? null,
      doc.sourceFile ?? "", doc.sourceLine ?? null, now, now, doc.completedAt ?? null]);
  } else if (kind === "brief") {
    await home("write", "INSERT INTO briefs (date, brief_json) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET brief_json = excluded.brief_json",
      [doc.date, JSON.stringify(doc.brief ?? null)]);
  } else if (kind === "prefs") {
    const { getNoticeService } = await import("../notifications/NoticeService.js");
    const svc = getNoticeService();
    svc.applyRemotePrefs(withLocalPrefs(doc, svc.prefs as unknown as Row));
  }
}

/** A task someone else owns (assigned to me) gets its own local id so it can't collide with mine. */
const localTaskId = (doc: Row, me?: string) => (doc.userId && me && doc.userId !== me ? `from:${doc.userId}:${doc.taskId}` : String(doc.taskId));

/* ---------- one cycle ---------- */

export interface CycleResult { pulled: number; pushed: number; conflicts: string[] }

async function pull(state: State, local: Map<string, { kind: string; data: Row }>): Promise<number> {
  const me = cloudActingUserId();
  let n = 0;
  for (let page = 0; page < 20; page++) {
    const qs = state.cursor ? `?since=${encodeURIComponent(state.cursor)}` : "";
    const r = must(await call(`/focus/changes${qs}`, "GET"), "pull").json as Row;
    const items: Array<[string, string, Row, Row]> = [];
    for (const g of (r.goals as Row[]) ?? []) items.push(["goal", `goal:${g.goalId}`, g, shape(GOAL_KEYS, g)]);
    for (const t of (r.tasks as Row[]) ?? []) items.push(["task", `task:${localTaskId(t, me)}`, t, shape(TASK_KEYS, t)]);
    for (const b of (r.briefs as Row[]) ?? []) items.push(["brief", `brief:${b.date}`, b, shape(BRIEF_KEYS, b)]);
    if (r.prefs) items.push(["prefs", "prefs", (r.prefs as Row).prefs as Row, sharedPrefs((r.prefs as Row).prefs as Row)]);
    for (const [kind, key, doc, data] of items) {
      const base = state.base[key];
      const mine = local.get(key)?.data;
      const unsent = base && mine && !same(mine, base.data);
      if (!unsent && !(mine && same(mine, data))) {
        try { await applyLocal(kind, doc, me); n++; } catch (e) { console.warn(`[FocusCloud] apply ${key}: ${(e as Error).message.slice(0, 120)}`); continue; }
        local.set(key, { kind, data });
      }
      // An unsent local edit keeps its old base, so the push gets a 409 and merges field by field.
      if (!unsent) state.base[key] = { rev: doc.rev as number | undefined, key: doc.key as string | undefined, data };
    }
    state.cursor = String(r.cursor ?? state.cursor ?? "");
    if (!r.more) break;
  }
  return n;
}

function pathFor(kind: string, key: string): string {
  if (kind === "goal") return "/focus/goals";
  if (kind === "task") return "/focus/tasks";
  if (kind === "brief") return `/focus/briefs/${key.slice(6)}`;
  return "/focus/prefs";
}

async function push(state: State, local: Map<string, { kind: string; data: Row }>, conflicts: string[]): Promise<number> {
  let n = 0;
  for (const [key, { kind, data }] of local) {
    const base = state.base[key];
    if (base && same(base.data, data)) continue;
    if (kind === "task" && key.startsWith("task:from:")) {
      // Assigned to me by someone else: I can only change its status.
      if (!base?.key || same(base.data.status, data.status)) continue;
    }
    const body = (d: Row, rev?: number): Row => kind === "prefs" ? { prefs: d, deviceId: state.deviceId }
      : { ...d, ...(kind === "task" && base?.key ? { key: base.key, taskId: base.data.taskId } : {}), rev: rev ?? null, deviceId: state.deviceId };
    let r = must(await call(pathFor(kind, key), "PUT", body(data, base?.rev)), `push ${key}`);
    let sent = data;
    if (r.status === 409) {
      const theirs = shape(kind === "goal" ? GOAL_KEYS : kind === "task" ? TASK_KEYS : BRIEF_KEYS, (r.json.current ?? {}) as Row);
      const m = mergeOnConflict(base?.data, data, theirs);
      if (m.conflicts.length) conflicts.push(`${key} (${m.conflicts.join(", ")})`);
      r = must(await call(pathFor(kind, key), "PUT", body(m.merged, (r.json.current as Row)?.rev as number)), `push ${key} after merge`);
      if (r.status === 409) continue; // changed again; next cycle
      sent = m.merged;
      if (!same(m.merged, data)) await applyLocal(kind, { ...(r.json.goal ?? r.json.task ?? r.json.brief ?? m.merged) as Row }).catch(() => undefined);
    }
    const doc = (r.json.goal ?? r.json.task ?? r.json.brief ?? {}) as Row;
    state.base[key] = { rev: doc.rev as number | undefined, key: (doc.key as string | undefined) ?? base?.key, data: sent };
    n++;
  }
  return n;
}

function tellConflicts(conflicts: string[]): void {
  if (!conflicts.length) return;
  void import("../notifications/NoticeService.js").then(({ tryNotify }) => tryNotify({
    key: "focus-sync:conflict", kind: "focus.conflict", type: "event", level: "fyi",
    title: conflicts.length === 1 ? "A goal changed on two devices" : `${conflicts.length} items changed on two devices`,
    body: `Kept the newer copy for ${conflicts.map((c) => c.replace(/^(goal|task|brief):/, "")).join("; ")}. Check it's right.`,
    source: { type: "platform", id: "focus", name: "Focus" },
    owner: { kind: "account", id: "focus", name: "Focus" },
  })).catch(() => undefined);
}

export async function syncFocus(reason = "manual"): Promise<CycleResult | null> {
  const state = await loadState();
  const conflicts: string[] = [];
  try {
    const local = await localItems();
    const firstRun = !state.cursor;
    const pulled = await pull(state, local);
    if (firstRun && !Object.keys(state.base).length) {
      // Empty server: send what we have once, history included (import keeps anything already there).
      const history = await q("SELECT goal_id, field, old_value, new_value, changed_at FROM goal_history ORDER BY changed_at LIMIT 2000");
      must(await call("/focus/import", "POST", {
        goals: [...local.values()].filter((x) => x.kind === "goal").map((x) => x.data),
        history: history.map((h) => ({ goalId: h.goal_id, field: h.field, old: h.old_value, new: h.new_value, changedAt: h.changed_at })),
        deviceId: state.deviceId,
      }), "import");
      await pull(state, local); // picks up revs for what we just sent
    }
    const pushed = await push(state, local, conflicts);
    tellConflicts(conflicts);
    if (pulled || pushed) console.log(`[FocusCloud] ${reason}: pulled=${pulled} pushed=${pushed}${conflicts.length ? ` conflicts=${conflicts.length}` : ""}`);
    return { pulled, pushed, conflicts };
  } catch (e) {
    if (e instanceof Skip) return null;
    throw e;
  } finally {
    await saveState(state);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;

/** Debounced, single-flight, fire-and-forget. Call after any Focus write and on focus.changed. */
export function scheduleFocusCloudSync(reason: string, delayMs = 3000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const run = (running ?? Promise.resolve()).then(() => syncFocus(reason)).then(() => undefined)
      .catch((e: Error) => console.warn(`[FocusCloud] ${reason} skipped: ${e.message.slice(0, 160)}`));
    running = run.finally(() => { if (running === run) running = null; });
  }, delayMs);
}

/** After a workspace switch the next cycle starts over (full pull) for the new workspace. */
export async function resetFocusCloudSyncForWorkspaceSwitch(): Promise<void> {
  const s = await loadState();
  await saveState({ v: 2, deviceId: s.deviceId, base: {} });
}
