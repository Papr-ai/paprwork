/**
 * Focus data → memory server (/v1/cloud/collab/focus/*), so the web, cloud runs and teammates see the
 * same goals, tasks, Daily Briefs and notification settings as the desktop.
 *
 * The desktop stays the source of truth: Home's SQLite (goals, goal_history, tasks, briefs) and
 * notice_prefs are what the app reads. After a write we schedule one debounced pass that pushes only
 * rows whose content changed since the last push (hashes kept in data/focus-cloud-sync.json).
 * The first pass per workspace sends everything through /focus/import (safe to repeat).
 * Never throws and never blocks the write: signed out, offline or an older server just skips.
 */
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { DEFAULT_HOME_APP_ID } from "../defaultHomeBundle.js";
import { toCloudBrief, toCloudGoal, toCloudTask, type Row } from "./focusCloudMap.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);
const BRIEF_DAYS = 14;

interface State { imported?: boolean; hashes: Record<string, string> }

async function homeQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/db/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: DEFAULT_HOME_APP_ID, sql, params }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; rows?: Row[] };
  if (!res.ok || data.error) throw new Error(data.error ?? `home db HTTP ${res.status}`);
  return data.rows ?? [];
}
const safeQuery = (sql: string, params: unknown[] = []) => homeQuery(sql, params).catch(() => [] as Row[]);

async function stateFile(): Promise<string> {
  const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
  return path.join(getPaprRoot(), "data", "focus-cloud-sync.json");
}
async function loadState(): Promise<State> {
  try { return JSON.parse(readFileSync(await stateFile(), "utf8")) as State; } catch { return { hashes: {} }; }
}
async function saveState(s: State): Promise<void> {
  const f = await stateFile();
  try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(s)); } catch { /* next pass retries */ }
}

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

async function send(p: string, method: "PUT" | "POST", body: unknown): Promise<"ok" | "skip"> {
  const res = await cloudApiFetch(`/v1/cloud/collab${p}`, { method, body, timeoutMs: 20_000 });
  if (res.status === 404 || res.status === 501) return "skip"; // older server
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return "ok";
}

/** Everything we mirror, in the server's shape, keyed by a stable id. */
export async function readFocusSnapshot(prefs?: unknown) {
  const goals = await safeQuery("SELECT * FROM goals");
  const links = await safeQuery("SELECT goal_id, entity_ref FROM goal_entities");
  const tasks = await safeQuery("SELECT * FROM tasks");
  const since = new Date(Date.now() - BRIEF_DAYS * 86_400_000).toISOString().slice(0, 10);
  const briefs = await safeQuery("SELECT date, brief_json FROM briefs WHERE date >= ?", [since]);
  const reviews = await safeQuery("SELECT * FROM brief_reviews WHERE brief_date >= ?", [since]);
  const history = await safeQuery("SELECT goal_id, field, old_value, new_value, changed_at FROM goal_history ORDER BY changed_at LIMIT 2000");
  return {
    goals: goals.map((g) => toCloudGoal(g, links)),
    tasks: tasks.map(toCloudTask),
    briefs: briefs.map((b) => toCloudBrief(b, reviews)),
    history: history.map((h) => ({ goalId: h.goal_id, field: h.field, old: h.old_value, new: h.new_value, changedAt: h.changed_at })),
    prefs,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;

/** One pass now. Returns what was pushed (for logs and tests). */
export async function syncFocusToCloud(reason = "manual"): Promise<{ goals: number; tasks: number; briefs: number; prefs: boolean } | null> {
  const { getNoticeService } = await import("../notifications/NoticeService.js");
  const snap = await readFocusSnapshot(getNoticeService().prefs);
  const state = await loadState();
  const out = { goals: 0, tasks: 0, briefs: 0, prefs: false };
  try {
    if (!state.imported) {
      if ((await send("/focus/import", "POST", { goals: snap.goals, tasks: snap.tasks, briefs: snap.briefs, history: snap.history })) === "skip") return null;
      state.imported = true;
    }
    const push = async (k: string, v: unknown, p: string) => {
      const h = hash(v);
      if (state.hashes[k] === h) return false;
      if ((await send(p, "PUT", v)) === "skip") return false;
      state.hashes[k] = h;
      return true;
    };
    for (const g of snap.goals) if (await push(`goal:${g.goalId}`, g, "/focus/goals")) out.goals++;
    for (const t of snap.tasks) if (await push(`task:${t.taskId}`, t, "/focus/tasks")) out.tasks++;
    for (const b of snap.briefs) if (await push(`brief:${b.date}`, b, `/focus/briefs/${b.date}`)) out.briefs++;
    out.prefs = await push("prefs", { prefs: snap.prefs }, "/focus/prefs");
  } finally {
    await saveState(state);
  }
  if (out.goals || out.tasks || out.briefs || out.prefs) console.log(`[FocusCloud] ${reason}: goals=${out.goals} tasks=${out.tasks} briefs=${out.briefs} prefs=${out.prefs}`);
  return out;
}

/** Debounced, fire-and-forget. Call after any Focus write. */
export function scheduleFocusCloudSync(reason: string, delayMs = 5000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const run = (running ?? Promise.resolve()).then(() => syncFocusToCloud(reason)).then(() => undefined)
      .catch((e: Error) => console.warn(`[FocusCloud] ${reason} skipped: ${e.message.slice(0, 160)}`));
    running = run.finally(() => { if (running === run) running = null; });
  }, delayMs);
}

/** After a workspace switch the next pass imports the new workspace. */
export async function resetFocusCloudSyncForWorkspaceSwitch(): Promise<void> {
  await saveState({ hashes: {} });
}
