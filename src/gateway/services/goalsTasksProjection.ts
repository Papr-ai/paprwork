/**
 * Goals + Tasks projection — markdown canonical, SQLite derived.
 *
 *   IDENTITY.md ## Goals  +  goals/archive.md   →  goals, goal_history
 *   L3 goal blocks        +  entities/** ## Open Items  →  tasks
 *   goal `Entities:` line +  entity frontmatter `goals:` →  goal_entities (both directions; untagged tasks inherit the page's single goal)
 *
 * Runs on boot, after Sleep / Wiki Writer complete, on workspace file change
 * (debounced), and via POST /api/workspace/project. Idempotent: rows are
 * upserted by stable id; a goal_history row is written whenever a tracked
 * field changes; rows whose source block disappeared are marked (goals →
 * archived=1 if found in archive, else left as-is with a warning; tasks →
 * dropped) rather than deleted, so history survives.
 *
 * All writes go through the gateway's own /api/db/write (loopback with the
 * Home app id) so routing matches every other writer. Pure parsing lives in
 * projectWorkspace() so it can be unit-tested without a DB.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getPaprDataDir, getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { DEFAULT_HOME_APP_ID, DEFAULT_HOME_BRIEFS_DB_SLUG } from "./defaultHomeBundle.js";
import {
  extractGoalsSection,
  parseArchive,
  parseGoals,
  type WorkspaceGoal,
} from "./workspaceGoals.js";

export interface GoalRow {
  id: string;
  title: string;
  level: string;
  parent_id: string | null;
  status: string;
  confidence: string;
  priority: number;
  period: string | null;
  opened: string | null;
  closed: string | null;
  next_milestone: string | null;
  owner: string | null;
  evidence: string | null;
  mentions: number | null;
  outcome: string | null;
  archived: number;
  parent_missing: number;
  source_file: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: "open" | "done" | "dropped";
  owner: string;
  due: string | null;
  goal_id: string | null;
  /** tag = explicit "(Gn)"; entity = inherited from the page's single goal; parent = L3 block Parent. */
  goal_source: "tag" | "entity" | "parent" | null;
  entity_ref: string | null;
  source: "l3-goal" | "open-item";
  source_file: string;
  source_line: number | null;
}

export interface GoalEntityRow {
  id: string;
  goal_id: string;
  entity_ref: string;
  entity_type: string;
  source: "goal" | "entity" | "both";
}

export interface ProjectionSnapshot {
  goals: GoalRow[];
  tasks: TaskRow[];
  goalEntities: GoalEntityRow[];
}

/** Read `goals: [G3, G7]` (or `goals:\n  - G3`) from an entity page's YAML frontmatter. */
export function parseEntityGoals(markdown: string): string[] {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const inline = fm[1].match(/^goals:\s*\[([^\]]*)\]/m);
  const ids = new Set<string>();
  if (inline) {
    for (const p of inline[1].split(",")) {
      const m = p.trim().replace(/^["']|["']$/g, "").match(/^(G\d+)$/i);
      if (m) ids.add(m[1].toUpperCase());
    }
  } else {
    const block = fm[1].match(/^goals:\s*\n((?:\s+-\s*[^\n]+\n?)+)/m);
    if (block) {
      for (const line of block[1].split("\n")) {
        const m = line.trim().match(/^-\s*["']?(G\d+)["']?$/i);
        if (m) ids.add(m[1].toUpperCase());
      }
    }
  }
  return [...ids];
}

const HISTORY_FIELDS = [
  "status",
  "confidence",
  "priority",
  "parent_id",
  "period",
  "archived",
  "title",
] as const;

function goalToRow(g: WorkspaceGoal, sourceFile: string, archived: boolean): GoalRow {
  return {
    id: g.id,
    title: g.title,
    level: g.level,
    parent_id: g.parent ?? null,
    status: g.status,
    confidence: g.confidence,
    priority: g.priority,
    period: g.period ?? null,
    opened: g.opened ?? null,
    closed: g.closed ?? null,
    next_milestone: g.nextMilestone ?? null,
    owner: g.owner ?? null,
    evidence: g.evidence ?? null,
    mentions: g.mentions ?? null,
    outcome: g.outcome ?? null,
    archived: archived ? 1 : 0,
    parent_missing: g.parentMissing ? 1 : 0,
    source_file: sourceFile,
  };
}

function dueFrom(text: string): string | null {
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

function normalizeTitle(s: string): string {
  return s
    .replace(/\s*\((?:G\d+|no-goal)\)\s*$/i, "")
    .replace(/\s*\(by [^)]*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Parse `## Open Items` checkboxes from one entity page into task rows. */
export function parseOpenItemTasks(markdown: string, entityRef: string, sourceFile: string): TaskRow[] {
  const start = markdown.search(/^## Open Items[^\n]*\n/m);
  if (start < 0) return [];
  const afterHeading = markdown.indexOf("\n", start) + 1;
  const rest = markdown.slice(afterHeading);
  const next = rest.search(/^## /m);
  const body = next < 0 ? rest : rest.slice(0, next);
  const tasks: TaskRow[] = [];
  let index = -1;
  for (const line of body.split("\n")) {
    const m = line.trim().match(/^[-*]\s*\[([xX ])\]\s*(.+)$/);
    if (!m) continue;
    index += 1;
    let text = m[2].trim();
    let owner = "unknown";
    const cat = text.match(/^\[(user|agent|papr|config)\]\s*(.*)$/i);
    if (cat) {
      owner = cat[1].toLowerCase();
      text = cat[2].trim();
    }
    if (/^\(?no open items\)?$/i.test(text)) continue;
    const goal = text.match(/\((G\d+)\)\s*$/i);
    const key = createHash("sha1").update(`${entityRef}|${normalizeTitle(text)}`).digest("hex").slice(0, 16);
    tasks.push({
      id: `item:${key}`,
      title: text.replace(/\s*\((?:G\d+|no-goal)\)\s*$/i, "").trim(),
      status: m[1].toLowerCase() === "x" ? "done" : "open",
      owner,
      due: dueFrom(text),
      goal_id: goal ? goal[1].toUpperCase() : null,
      goal_source: goal ? "tag" : null,
      entity_ref: entityRef,
      source: "open-item",
      source_file: sourceFile,
      source_line: index,
    });
  }
  return tasks;
}

export interface WorkspaceInput {
  identity: string | null;
  archive: string | null;
  /** entity pages: workspace-relative path → markdown */
  entities: Record<string, string>;
}

/** Pure projection: workspace markdown → rows. No I/O. */
export function projectWorkspace(input: WorkspaceInput): ProjectionSnapshot {
  const goals: GoalRow[] = [];
  const tasks: TaskRow[] = [];
  const active = input.identity ? parseGoals(extractGoalsSection(input.identity) ?? "") : [];
  for (const g of active) goals.push(goalToRow(g, "IDENTITY.md", false));
  const activeIds = new Set(active.map((g) => g.id));
  if (input.archive) {
    for (const g of parseArchive(input.archive)) {
      if (activeIds.has(g.id)) continue; // reopened — IDENTITY wins
      goals.push(goalToRow(g, "goals/archive.md", true));
    }
  }
  // L3 goals are tasks with a goal parent.
  for (const g of active) {
    if (g.level !== "L3") continue;
    tasks.push({
      id: `goal:${g.id}`,
      title: g.title,
      status: g.status === "done" ? "done" : g.status === "dropped" ? "dropped" : "open",
      owner: g.owner?.toLowerCase() === "agent" ? "agent" : "user",
      due: g.nextMilestone ? dueFrom(g.nextMilestone) : null,
      goal_id: g.parent ?? null,
      goal_source: g.parent ? "parent" : null,
      entity_ref: null,
      source: "l3-goal",
      source_file: "IDENTITY.md",
      source_line: null,
    });
  }
  // Goal ↔ entity links, from both sides.
  const links = new Map<string, GoalEntityRow>();
  const link = (goalId: string, ref: string, side: "goal" | "entity") => {
    const id = `${goalId}|${ref}`;
    const prev = links.get(id);
    links.set(id, {
      id,
      goal_id: goalId,
      entity_ref: ref,
      entity_type: ref.split("/")[0],
      source: prev && prev.source !== side ? "both" : side,
    });
  };
  const allGoals = [...active, ...(input.archive ? parseArchive(input.archive) : [])];
  const knownGoalIds = new Set(allGoals.map((g) => g.id));
  for (const g of allGoals) for (const ref of g.entities ?? []) link(g.id, ref, "goal");
  const entityGoals = new Map<string, string[]>();
  for (const [rel, md] of Object.entries(input.entities)) {
    const ref = rel.replace(/^entities\//, "").replace(/\.md$/, "");
    const ids = parseEntityGoals(md).filter((id) => knownGoalIds.has(id));
    entityGoals.set(ref, ids);
    for (const id of ids) link(id, ref, "entity");
  }
  // Union per entity (goal side + entity side) drives inheritance.
  const goalsForEntity = new Map<string, Set<string>>();
  for (const row of links.values()) {
    if (!goalsForEntity.has(row.entity_ref)) goalsForEntity.set(row.entity_ref, new Set());
    goalsForEntity.get(row.entity_ref)!.add(row.goal_id);
  }
  for (const [rel, md] of Object.entries(input.entities)) {
    const ref = rel.replace(/^entities\//, "").replace(/\.md$/, "");
    const inherited = [...(goalsForEntity.get(ref) ?? [])].filter((id) => activeIds.has(id));
    for (const t of parseOpenItemTasks(md, ref, rel)) {
      // Untagged task on a page with exactly one active goal inherits it.
      if (!t.goal_id && inherited.length === 1) {
        t.goal_id = inherited[0];
        t.goal_source = "entity";
      }
      tasks.push(t);
    }
  }
  return { goals, tasks, goalEntities: [...links.values()] };
}

async function readWorkspaceInput(): Promise<WorkspaceInput> {
  const ws = getPaprWorkspaceDir();
  const readOpt = async (p: string) => {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  };
  const entities: Record<string, string> = {};
  const entDir = path.join(ws, "entities");
  try {
    for (const type of await fs.readdir(entDir)) {
      const typeDir = path.join(entDir, type);
      let files: string[] = [];
      try {
        files = await fs.readdir(typeDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md") || f.includes(".backup")) continue;
        const md = await readOpt(path.join(typeDir, f));
        if (md) entities[`entities/${type}/${f}`] = md;
      }
    }
  } catch {
    /* no entities yet */
  }
  return {
    identity: await readOpt(path.join(ws, "IDENTITY.md")),
    archive: await readOpt(path.join(ws, "goals", "archive.md")),
    entities,
  };
}

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);

/** Ensure goals/tasks DDL exists on the Home briefs DB (replica handle, not raw sqlite3). */
async function ensureHomeGoalsTasksSchema(): Promise<void> {
  const dbPath = path.join(
    getPaprDataDir(),
    "databases",
    DEFAULT_HOME_BRIEFS_DB_SLUG,
    "data.db",
  );
  try {
    await fs.access(dbPath);
  } catch {
    return;
  }
  const { applyRegistryDatabaseMigrations } = await import("./jobs/databaseMigrations.js");
  const applied = await applyRegistryDatabaseMigrations(dbPath);
  if (applied.length > 0) {
    console.log(
      `[GoalsTasksProjection] Applied Home briefs migrations: ${applied.join(", ")}`,
    );
  }
  const { getTursoReplicaSyncWorkerClient } = await import(
    "./tursoReplica/TursoReplicaSyncWorkerClient.js"
  );
  await getTursoReplicaSyncWorkerClient().close(dbPath).catch(() => undefined);
}

/**
 * Loopback to the gateway's own /api/db/* routes with the Home app id — the
 * same path save_brief.py and the Home app use, so replica-vs-legacy routing,
 * the briefs write guard, and sourceId resolution are identical to every
 * other writer. Keeps this service out of the pool/dbRouter closure.
 */
async function homeDb(endpoint: "query" | "write", sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/db/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: DEFAULT_HOME_APP_ID, sql, params: params ?? [] }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; rows?: Record<string, unknown>[] };
  if (!res.ok || data.error) throw new Error(data.error ?? `gateway ${endpoint} HTTP ${res.status}`);
  return data.rows ?? [];
}

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Apply a snapshot to the DB. Exposed for tests with in-memory exec/query fakes. */
export async function applySnapshot(
  snap: ProjectionSnapshot,
  exec: Exec,
  query: Query,
  now = new Date().toISOString(),
): Promise<{ goalsUpserted: number; historyRows: number; tasksUpserted: number; tasksDropped: number; links: number }> {
  let historyRows = 0;
  const existing = new Map<string, Record<string, unknown>>();
  for (const row of await query("SELECT * FROM goals")) existing.set(String(row.id), row);

  for (const g of snap.goals) {
    const prev = existing.get(g.id);
    if (prev) {
      const cur = g as unknown as Record<string, unknown>;
      for (const f of HISTORY_FIELDS) {
        const oldV = prev[f] == null ? null : String(prev[f]);
        const newV = cur[f] == null ? null : String(cur[f]);
        if (oldV !== newV) {
          historyRows += 1;
          await exec(
            "INSERT OR REPLACE INTO goal_history (id, goal_id, changed_at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)",
            [`${g.id}:${now}:${f}`, g.id, now, f, oldV, newV],
          );
        }
      }
    } else {
      historyRows += 1;
      await exec(
        "INSERT OR REPLACE INTO goal_history (id, goal_id, changed_at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)",
        [`${g.id}:${now}:created`, g.id, now, "status", null, g.status],
      );
    }
    await exec(
      `INSERT INTO goals (id, title, level, parent_id, status, confidence, priority, period, opened, closed, next_milestone, owner, evidence, mentions, outcome, archived, parent_missing, source_file, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, level=excluded.level, parent_id=excluded.parent_id, status=excluded.status, confidence=excluded.confidence, priority=excluded.priority, period=excluded.period, opened=excluded.opened, closed=excluded.closed, next_milestone=excluded.next_milestone, owner=excluded.owner, evidence=excluded.evidence, mentions=excluded.mentions, outcome=excluded.outcome, archived=excluded.archived, parent_missing=excluded.parent_missing, source_file=excluded.source_file, updated_at=excluded.updated_at`,
      [g.id, g.title, g.level, g.parent_id, g.status, g.confidence, g.priority, g.period, g.opened, g.closed, g.next_milestone, g.owner, g.evidence, g.mentions, g.outcome, g.archived, g.parent_missing, g.source_file, now, now],
    );
  }

  // Goal ↔ entity links: replace the set wholesale (small, derived, no history needed).
  const seenLinks = new Set(snap.goalEntities.map((l) => l.id));
  for (const row of await query("SELECT id FROM goal_entities")) {
    const id = String(row.id);
    if (!seenLinks.has(id)) await exec("DELETE FROM goal_entities WHERE id = ?", [id]);
  }
  for (const l of snap.goalEntities) {
    await exec(
      `INSERT INTO goal_entities (id, goal_id, entity_ref, entity_type, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source=excluded.source, updated_at=excluded.updated_at`,
      [l.id, l.goal_id, l.entity_ref, l.entity_type, l.source, now],
    );
  }

  const seenTasks = new Set(snap.tasks.map((t) => t.id));
  let tasksDropped = 0;
  for (const row of await query("SELECT id, status FROM tasks WHERE status = 'open'")) {
    const id = String(row.id);
    if (!seenTasks.has(id)) {
      tasksDropped += 1;
      await exec("UPDATE tasks SET status = 'dropped', updated_at = ? WHERE id = ?", [now, id]);
    }
  }
  for (const t of snap.tasks) {
    await exec(
      `INSERT INTO tasks (id, title, status, owner, due, goal_id, goal_source, entity_ref, source, source_file, source_line, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, owner=excluded.owner, due=excluded.due, goal_id=excluded.goal_id, goal_source=excluded.goal_source, entity_ref=excluded.entity_ref, source=excluded.source, source_file=excluded.source_file, source_line=excluded.source_line, updated_at=excluded.updated_at,
         completed_at = CASE WHEN excluded.status = 'done' THEN COALESCE(tasks.completed_at, excluded.updated_at) ELSE NULL END`,
      [t.id, t.title, t.status, t.owner, t.due, t.goal_id, t.goal_source, t.entity_ref, t.source, t.source_file, t.source_line, now, now, t.status === "done" ? now : null],
    );
  }
  return { goalsUpserted: snap.goals.length, historyRows, tasksUpserted: snap.tasks.length, tasksDropped, links: snap.goalEntities.length };
}

let running: Promise<unknown> | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/** Project the live workspace into the Home DB. Coalesces concurrent calls. */
export async function projectGoalsAndTasks(reason = "manual"): Promise<
  | { ok: true; goalsUpserted: number; historyRows: number; tasksUpserted: number; tasksDropped: number; links: number }
  | { ok: false; error: string }
> {
  if (running) {
    await running.catch(() => undefined);
  }
  const run = (async () => {
    await ensureHomeGoalsTasksSchema();
    const exec: Exec = (sql, params) => homeDb("write", sql, params);
    const query: Query = (sql, params) => homeDb("query", sql, params);
    const snap = projectWorkspace(await readWorkspaceInput());
    const res = await applySnapshot(snap, exec, query);
    console.log(
      `[GoalsTasksProjection] ${reason}: goals=${res.goalsUpserted} history+${res.historyRows} tasks=${res.tasksUpserted} dropped=${res.tasksDropped} links=${res.links}`,
    );
    return { ok: true as const, ...res };
  })();
  running = run;
  try {
    return await run;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[GoalsTasksProjection] ${reason} failed: ${error}`);
    return { ok: false, error };
  } finally {
    running = null;
  }
}

/** Debounced trigger for file watchers. */
export function scheduleGoalsTasksProjection(reason: string, delayMs = 4000): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void projectGoalsAndTasks(reason);
  }, delayMs);
}

/** Workspace-relative paths whose change should re-project. */
export function isGoalsTasksSourcePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return (
    p === "IDENTITY.md" ||
    p === "goals/archive.md" ||
    (p.startsWith("entities/") && p.endsWith(".md") && !p.includes(".backup"))
  );
}
