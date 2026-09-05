/**
 * Unified tasks — read side + completion write-back.
 *
 * The `tasks` table (Home DB) is a projection of L3 goal blocks in IDENTITY.md
 * and `## Open Items` checkboxes on entity pages. Reads come from the table;
 * completing a task writes back to the *source markdown* (tick the checkbox /
 * set the L3 block's Status: done) and then re-projects, so markdown stays
 * canonical and every agent sees the same state.
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { DEFAULT_HOME_APP_ID } from "./defaultHomeBundle.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);

export interface TaskRecord {
  id: string;
  title: string;
  status: string;
  owner: string;
  due: string | null;
  goal_id: string | null;
  entity_ref: string | null;
  source: string;
  source_file: string;
  source_line: number | null;
  updated_at: string;
  completed_at: string | null;
}

async function homeQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/db/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: DEFAULT_HOME_APP_ID, sql, params }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; rows?: Record<string, unknown>[] };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.rows ?? [];
}

export async function readWorkspaceTasks(opts: { status?: string } = {}): Promise<{
  tasks: TaskRecord[];
  counts: { open: number; done: number; dropped: number };
  dbAvailable: boolean;
}> {
  try {
    const where = opts.status && opts.status !== "all" ? "WHERE status = ?" : "";
    const params = opts.status && opts.status !== "all" ? [opts.status] : [];
    const rows = (await homeQuery(
      `SELECT * FROM tasks ${where} ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, owner, title`,
      params,
    )) as unknown as TaskRecord[];
    const counts = { open: 0, done: 0, dropped: 0 };
    for (const r of await homeQuery("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) {
      const k = String(r.status) as keyof typeof counts;
      if (k in counts) counts[k] = Number(r.n);
    }
    return { tasks: rows, counts, dbAvailable: true };
  } catch {
    // Pre-migration install or gateway not ready.
    return { tasks: [], counts: { open: 0, done: 0, dropped: 0 }, dbAvailable: false };
  }
}

/**
 * Tick / untick the Nth checkbox under `## Open Items` in an entity file.
 * Same index semantics as the wiki UI's toggle (0-based across checkbox lines).
 */
export function toggleOpenItemInMarkdown(markdown: string, index: number, done: boolean): string | null {
  const start = markdown.search(/^## Open Items[^\n]*\n/m);
  if (start < 0) return null;
  const afterHeading = markdown.indexOf("\n", start) + 1;
  const rest = markdown.slice(afterHeading);
  const next = rest.search(/^## /m);
  const bodyEnd = next < 0 ? markdown.length : afterHeading + next;
  const lines = markdown.slice(afterHeading, bodyEnd).split("\n");
  let i = -1;
  for (let n = 0; n < lines.length; n += 1) {
    const m = lines[n].match(/^(\s*[-*]\s*\[)([xX ])(\]\s*.*)$/);
    if (!m) continue;
    i += 1;
    if (i !== index) continue;
    lines[n] = `${m[1]}${done ? "x" : " "}${m[3]}`;
    return markdown.slice(0, afterHeading) + lines.join("\n") + markdown.slice(bodyEnd);
  }
  return null;
}

/** Set an L3 goal block's Status (and Closed/Outcome when done) in IDENTITY.md. */
export function setGoalStatusInMarkdown(
  identity: string,
  goalId: string,
  status: "done" | "on-track",
  today: string,
  outcome?: string,
): string | null {
  const re = new RegExp(`(^### ${goalId}\\s*[—–-][^\\n]*\\n)([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`, "m");
  const m = identity.match(re);
  if (!m) return null;
  let block = m[2];
  const setLine = (key: string, value: string) => {
    const lineRe = new RegExp(`^(\\s*-\\s*${key}:\\s*).*$`, "mi");
    block = lineRe.test(block) ? block.replace(lineRe, `$1${value}`) : block.replace(/\n?$/, `\n- ${key}: ${value}\n`);
  };
  setLine("Status", status);
  if (status === "done") {
    setLine("Closed", today);
    if (outcome) setLine("Outcome", outcome);
  } else {
    setLine("Closed", "—");
  }
  return identity.slice(0, m.index! + m[1].length) + block + identity.slice(m.index! + m[0].length);
}

/**
 * Complete (or reopen) a task by editing its source markdown, then re-project.
 * Returns the source file touched, or null when the task is unknown / not found.
 */
export async function setTaskDone(taskId: string, done: boolean, outcome?: string): Promise<{ ok: boolean; sourceFile?: string; error?: string }> {
  const rows = (await homeQuery("SELECT * FROM tasks WHERE id = ?", [taskId])) as unknown as TaskRecord[];
  const task = rows[0];
  if (!task) return { ok: false, error: `task not found: ${taskId}` };
  const ws = getPaprWorkspaceDir();
  const file = path.join(ws, task.source_file);
  const today = new Date().toISOString().slice(0, 10);
  let md: string;
  try {
    md = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, error: `source file missing: ${task.source_file}` };
  }
  let updated: string | null = null;
  if (task.source === "open-item" && task.source_line != null) {
    updated = toggleOpenItemInMarkdown(md, task.source_line, done);
  } else if (task.source === "l3-goal") {
    updated = setGoalStatusInMarkdown(md, task.id.replace(/^goal:/, ""), done ? "done" : "on-track", today, outcome);
  }
  if (updated == null) return { ok: false, error: "could not locate task in source markdown" };
  if (updated !== md) await fs.writeFile(file, updated, "utf8");
  const { projectGoalsAndTasks } = await import("./goalsTasksProjection.js");
  await projectGoalsAndTasks(`task ${done ? "done" : "reopened"}`);
  return { ok: true, sourceFile: task.source_file };
}
