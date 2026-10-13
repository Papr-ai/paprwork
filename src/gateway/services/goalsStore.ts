/**
 * Goals store — the Home DB `goals` table is the source of truth.
 *
 * Every goal write (Home buttons, chat agent, Sleep) goes through
 * `updateGoal` / `createGoal` (exposed as PATCH/POST /api/workspace/goals).
 * Each write:
 *   1. validates fields (status must be canonical — "completed" is mapped to
 *      "done", junk is rejected with 400 instead of silently becoming "unknown"),
 *   2. writes the `goals` row + a `goal_history` row per changed field,
 *   3. mirrors the block into IDENTITY.md `## Goals` so agent context (which
 *      injects IDENTITY.md every turn) stays in sync.
 *
 * Reads (`readGoalsFromDb`) come from the table, so Home never re-parses
 * markdown. The markdown → DB projection still runs for hand edits, but it can
 * no longer downgrade a status to "unknown" (see applySnapshot).
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import { DEFAULT_HOME_APP_ID } from "./defaultHomeBundle.js";
import {
  buildGoalTree,
  normalizeGoalStatus,
  type GoalConfidence,
  type GoalLevel,
  type GoalStatus,
  type WorkspaceGoal,
  type WorkspaceGoalsResult,
} from "./workspaceGoals.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 18789);
const CANONICAL: ReadonlySet<string> = new Set(["proposed", "on-track", "at-risk", "blocked", "done", "dropped"]);
const LEVELS: ReadonlySet<string> = new Set(["L1", "L2", "L3"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["high", "medium", "low"]);

export class GoalValidationError extends Error {
  status = 400;
}

type Row = Record<string, unknown>;

async function homeDb(endpoint: "query" | "write", sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/db/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: DEFAULT_HOME_APP_ID, sql, params }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; rows?: Row[] };
  if (!res.ok || data.error) throw new Error(data.error ?? `gateway ${endpoint} HTTP ${res.status}`);
  return data.rows ?? [];
}

export interface GoalPatch {
  title?: string;
  status?: string;
  level?: string;
  parent?: string | null;
  confidence?: string;
  priority?: number;
  period?: string | null;
  nextMilestone?: string | null;
  owner?: string | null;
  outcome?: string | null;
  entities?: string[];
  evidence?: string | null;
  /** YYYY-MM-DD; defaults to today when closing. */
  closed?: string | null;
}

const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

/** Validate + normalise a patch. Throws GoalValidationError on bad input. Pure. */
export function validateGoalPatch(patch: GoalPatch, opts: { creating?: boolean } = {}): GoalPatch {
  const out: GoalPatch = { ...patch };
  if (patch.status !== undefined) {
    const s = normalizeGoalStatus(patch.status);
    if (!CANONICAL.has(s)) {
      throw new GoalValidationError(`invalid status "${patch.status}" — use one of: ${[...CANONICAL].join(", ")}`);
    }
    out.status = s;
  }
  if (patch.level !== undefined) {
    const l = String(patch.level).toUpperCase();
    if (!LEVELS.has(l)) throw new GoalValidationError(`invalid level "${patch.level}" — use L1, L2 or L3`);
    out.level = l;
  }
  if (patch.confidence !== undefined) {
    const c = String(patch.confidence).toLowerCase().replace(/^med.*/, "medium");
    if (!CONFIDENCE.has(c)) throw new GoalValidationError(`invalid confidence "${patch.confidence}" — use high, medium or low`);
    out.confidence = c;
  }
  if (patch.priority !== undefined) {
    const n = Number(patch.priority);
    if (!Number.isInteger(n) || n < 1) throw new GoalValidationError("priority must be a positive integer");
    out.priority = n;
  }
  if (patch.parent) {
    if (!/^G\d+$/i.test(patch.parent)) throw new GoalValidationError(`invalid parent "${patch.parent}" — use a goal id like G3`);
    out.parent = patch.parent.toUpperCase();
  }
  if (patch.closed && !/^\d{4}-\d{2}-\d{2}$/.test(patch.closed)) throw new GoalValidationError("closed must be YYYY-MM-DD");
  if (patch.period && !/^\d{4}(-Q[1-4])?$/.test(patch.period)) {
    throw new GoalValidationError(`invalid period "${patch.period}" — use YYYY or YYYY-Qn`);
  }
  if (patch.entities && !patch.entities.every((e) => /^[a-z-]+\/[a-z0-9-]+$/i.test(e))) {
    throw new GoalValidationError("entities must be refs like projects/x, companies/y, people/z");
  }
  if (opts.creating) {
    if (!patch.title?.trim()) throw new GoalValidationError("title is required");
    if (!out.level) throw new GoalValidationError("level is required (L1, L2 or L3)");
    if (out.level !== "L1" && !out.parent) throw new GoalValidationError(`${out.level} goals need a parent`);
  }
  if (patch.title !== undefined && !patch.title.trim()) throw new GoalValidationError("title cannot be empty");
  return out;
}

/* ---------------- markdown mirror ---------------- */

const FIELD_ORDER = ["Level", "Status", "Priority", "Confidence", "Period", "Opened", "Closed", "Parent", "Entities", "Evidence", "Next milestone", "Owner", "Outcome"] as const;

/** Row → the markdown fields we own. Unknown extra lines in the block (Structure:, Decisions Pending: …) are kept. */
function rowFields(r: Row): Record<string, string | undefined> {
  return {
    Level: str(r.level),
    Status: str(r.status),
    Priority: str(r.priority),
    Confidence: str(r.confidence),
    Period: str(r.period),
    Opened: str(r.opened),
    Closed: str(r.closed),
    Parent: str(r.parent_id),
    Entities: str(r.entities),
    Evidence: str(r.evidence),
    "Next milestone": str(r.next_milestone),
    Owner: str(r.owner),
    Outcome: str(r.outcome),
  };
}

function renderBlock(r: Row): string {
  const hashes = r.level === "L1" ? "###" : "####";
  const head = `${hashes} ${r.id} — ${r.title}${r.parent_id ? ` (Parent: ${r.parent_id})` : ""}`;
  const f = rowFields(r);
  const lines = FIELD_ORDER.filter((k) => f[k] !== undefined && k !== "Parent").map((k) => `- ${k}: ${f[k]}`);
  return `${head}\n${lines.join("\n")}\n`;
}

/**
 * Set fields on goal `id`'s block in IDENTITY.md, or append a new block at the
 * end of `## Goals` when it does not exist. Pure; returns the new markdown.
 */
export function upsertGoalBlockInMarkdown(identity: string, r: Row): string {
  const id = String(r.id);
  const re = new RegExp(`(^#{3,4} ${id}\\s*[—–-][^\\n]*\\n)([\\s\\S]*?)(?=^#{3,4} |^## |(?![\\s\\S]))`, "m");
  const m = identity.match(re);
  if (!m) {
    const start = identity.search(/^## Goals[^\n]*\n/m);
    const block = renderBlock(r);
    if (start < 0) return `${identity.replace(/\n*$/, "\n")}\n## Goals\n\n${block}`;
    const afterHeading = identity.indexOf("\n", start) + 1;
    const rest = identity.slice(afterHeading);
    const next = rest.search(/^## /m);
    const end = next < 0 ? identity.length : afterHeading + next;
    const body = identity.slice(afterHeading, end).replace(/\n*$/, "\n\n");
    return identity.slice(0, afterHeading) + body + block + "\n" + identity.slice(end);
  }
  const hashes = m[1].match(/^#+/)![0];
  const head = `${hashes} ${id} — ${r.title}${r.level !== "L1" && /\(Parent:/i.test(m[1]) && r.parent_id ? ` (Parent: ${r.parent_id})` : ""}\n`;
  let block = m[2];
  const f = rowFields(r);
  const parentInHead = /\(Parent:/i.test(m[1]);
  for (const key of FIELD_ORDER) {
    if (key === "Parent" && parentInHead) continue;
    const value = f[key];
    const lineRe = new RegExp(`^(\\s*-\\s*${key}:[ \\t]*).*$`, "mi");
    if (value === undefined) {
      // Reopened goal: blank a stale Closed date; otherwise never delete user-written lines.
      if (key === "Closed" && lineRe.test(block)) block = block.replace(lineRe, "$1—");
      continue;
    }
    block = lineRe.test(block) ? block.replace(lineRe, `$1${value}`) : block.replace(/\n*$/, `\n- ${key}: ${value}\n`);
  }
  if (!block.endsWith("\n\n") && identity.slice(m.index! + m[0].length).length) block = block.replace(/\n*$/, "\n\n");
  return identity.slice(0, m.index!) + head + block + identity.slice(m.index! + m[0].length);
}

async function mirrorToIdentity(row: Row): Promise<void> {
  const file = path.join(getPaprWorkspaceDir(), "IDENTITY.md");
  let md = "";
  try {
    md = await fs.readFile(file, "utf8");
  } catch {
    /* create */
  }
  const next = upsertGoalBlockInMarkdown(md, row);
  if (next !== md) await fs.writeFile(file, next, "utf8");
}

/* ---------------- writes ---------------- */

const HISTORY_FIELDS = ["title", "level", "parent_id", "status", "confidence", "priority", "period", "next_milestone", "outcome", "closed"];

async function getRow(id: string): Promise<Row | undefined> {
  return (await homeDb("query", "SELECT * FROM goals WHERE id = ?", [id]))[0];
}

async function entitiesFor(id: string): Promise<string[]> {
  const rows = await homeDb("query", "SELECT entity_ref FROM goal_entities WHERE goal_id = ? AND source IN ('goal','both') ORDER BY entity_ref", [id]);
  return rows.map((r) => String(r.entity_ref));
}

async function writeRow(prev: Row | undefined, next: Row, actor: string): Promise<void> {
  const now = new Date().toISOString();
  for (const f of HISTORY_FIELDS) {
    const o = prev?.[f] == null ? null : String(prev[f]);
    const n = next[f] == null ? null : String(next[f]);
    if (o !== n) {
      await homeDb("write", "INSERT OR REPLACE INTO goal_history (id, goal_id, changed_at, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)", [
        `${next.id}:${now}:${f}`, next.id, now, f, o, n,
      ]);
    }
  }
  await homeDb(
    "write",
    `INSERT INTO goals (id, title, level, parent_id, status, confidence, priority, period, opened, closed, next_milestone, owner, evidence, mentions, outcome, archived, parent_missing, source_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, level=excluded.level, parent_id=excluded.parent_id, status=excluded.status, confidence=excluded.confidence, priority=excluded.priority, period=excluded.period, opened=excluded.opened, closed=excluded.closed, next_milestone=excluded.next_milestone, owner=excluded.owner, evidence=excluded.evidence, outcome=excluded.outcome, updated_at=excluded.updated_at`,
    [next.id, next.title, next.level, next.parent_id ?? null, next.status, next.confidence, next.priority, next.period ?? null, next.opened ?? null, next.closed ?? null,
      next.next_milestone ?? null, next.owner ?? null, next.evidence ?? null, next.mentions ?? null, next.outcome ?? null, next.archived ?? 0, 0, next.source_file ?? "IDENTITY.md", prev?.created_at ?? now, now],
  );
  console.log(`[GoalsStore] ${actor}: ${prev ? "updated" : "created"} ${next.id} (${next.status})`);
}

async function setEntities(id: string, refs: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const r of await homeDb("query", "SELECT id, entity_ref, source FROM goal_entities WHERE goal_id = ?", [id])) {
    if (refs.includes(String(r.entity_ref))) continue;
    if (r.source === "both") await homeDb("write", "UPDATE goal_entities SET source = 'entity', updated_at = ? WHERE id = ?", [now, r.id]);
    else if (r.source === "goal") await homeDb("write", "DELETE FROM goal_entities WHERE id = ?", [r.id]);
  }
  for (const ref of refs) {
    await homeDb(
      "write",
      `INSERT INTO goal_entities (id, goal_id, entity_ref, entity_type, source, updated_at) VALUES (?, ?, ?, ?, 'goal', ?)
       ON CONFLICT(id) DO UPDATE SET source = CASE WHEN goal_entities.source = 'entity' THEN 'both' ELSE goal_entities.source END, updated_at = excluded.updated_at`,
      [`${id}|${ref}`, id, ref, ref.split("/")[0], now],
    );
  }
}

function applyPatch(base: Row, p: GoalPatch, today: string): Row {
  const next: Row = { ...base };
  if (p.title !== undefined) next.title = p.title.trim();
  if (p.level !== undefined) next.level = p.level;
  if (p.parent !== undefined) next.parent_id = p.parent || null;
  if (p.confidence !== undefined) next.confidence = p.confidence;
  if (p.priority !== undefined) next.priority = p.priority;
  if (p.period !== undefined) next.period = p.period || null;
  if (p.nextMilestone !== undefined) next.next_milestone = p.nextMilestone || null;
  if (p.owner !== undefined) next.owner = p.owner || null;
  if (p.evidence !== undefined) next.evidence = p.evidence || null;
  if (p.outcome !== undefined) next.outcome = p.outcome || null;
  if (p.status !== undefined) {
    next.status = p.status;
    const closing = p.status === "done" || p.status === "dropped";
    if (closing && !next.closed) next.closed = today;
    if (!closing) next.closed = null;
  }
  if (p.closed !== undefined && (next.status === "done" || next.status === "dropped")) next.closed = p.closed || next.closed;
  if (next.level === "L1") next.parent_id = null;
  return next;
}

export async function updateGoal(id: string, rawPatch: GoalPatch, actor = "api"): Promise<Row> {
  const gid = id.toUpperCase();
  const patch = validateGoalPatch(rawPatch);
  const prev = await getRow(gid);
  if (!prev) throw Object.assign(new Error(`goal not found: ${gid}`), { status: 404 });
  if (patch.parent && !(await getRow(patch.parent))) throw new GoalValidationError(`parent ${patch.parent} does not exist`);
  const today = new Date().toISOString().slice(0, 10);
  const next = applyPatch(prev, patch, today);
  if (next.status === "proposed" && prev.status === "proposed" && patch.confidence === undefined) next.confidence = prev.confidence;
  await writeRow(prev, next, actor);
  if (patch.entities) await setEntities(gid, patch.entities);
  // Closing a parent closes its open children (done if parent done, else dropped).
  if ((next.status === "done" || next.status === "dropped") && prev.status !== next.status) {
    for (const child of await homeDb("query", "SELECT * FROM goals WHERE parent_id = ? AND status NOT IN ('done','dropped')", [gid])) {
      await updateGoal(String(child.id), { status: next.status as string, outcome: `Closed with parent ${gid}` }, `${actor} (cascade)`);
    }
  }
  await mirrorToIdentity({ ...next, entities: (await entitiesFor(gid)).join(", ") || undefined });
  return next;
}

export async function createGoal(rawPatch: GoalPatch, actor = "api"): Promise<Row> {
  const patch = validateGoalPatch({ status: "proposed", confidence: "medium", ...rawPatch }, { creating: true });
  if (patch.parent) {
    const parent = await getRow(patch.parent);
    if (!parent) throw new GoalValidationError(`parent ${patch.parent} does not exist`);
    const want = patch.level === "L2" ? "L1" : "L2";
    if (parent.level !== want) throw new GoalValidationError(`${patch.level} parent must be an ${want} (${patch.parent} is ${parent.level})`);
  }
  const ids = await homeDb("query", "SELECT id FROM goals");
  const max = ids.reduce((n, r) => Math.max(n, Number(String(r.id).replace(/^G/i, "")) || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const base: Row = { id: `G${max + 1}`, title: "", level: patch.level, status: "proposed", confidence: "medium", priority: 99, opened: today, archived: 0, source_file: "IDENTITY.md" };
  const next = applyPatch(base, patch, today);
  await writeRow(undefined, next, actor);
  if (patch.entities?.length) await setEntities(String(next.id), patch.entities);
  await mirrorToIdentity({ ...next, entities: patch.entities?.join(", ") });
  return next;
}

/* ---------------- reads ---------------- */

export async function readGoalHistory(id: string): Promise<Row[]> {
  return homeDb("query", "SELECT changed_at, field, old_value, new_value FROM goal_history WHERE goal_id = ? ORDER BY changed_at DESC LIMIT 200", [id.toUpperCase()]);
}

function rowToGoal(r: Row, entities: string[]): WorkspaceGoal {
  return {
    id: String(r.id),
    title: String(r.title),
    status: (CANONICAL.has(String(r.status)) ? r.status : "unknown") as GoalStatus,
    level: String(r.level) as GoalLevel,
    confidence: (str(r.confidence) ?? "unknown") as GoalConfidence,
    priority: Number(r.priority ?? 99),
    parent: str(r.parent_id),
    nextMilestone: str(r.next_milestone),
    owner: str(r.owner),
    evidence: str(r.evidence),
    period: str(r.period),
    opened: str(r.opened),
    closed: str(r.closed),
    outcome: str(r.outcome),
    mentions: r.mentions == null ? undefined : Number(r.mentions),
    entities: entities.length ? entities : undefined,
    parentMissing: Number(r.parent_missing) === 1 || undefined,
  };
}

/** Same shape as readWorkspaceGoals(), served from the Home DB. Returns null when the table is unavailable. */
export async function readGoalsFromDb(): Promise<WorkspaceGoalsResult | null> {
  let rows: Row[];
  let links: Row[];
  try {
    rows = await homeDb("query", "SELECT * FROM goals ORDER BY level, priority, id");
    links = await homeDb("query", "SELECT goal_id, entity_ref FROM goal_entities WHERE source IN ('goal','both') ORDER BY entity_ref");
  } catch {
    return null;
  }
  if (!rows.length) return null; // let the markdown path decide empty vs. never-projected
  const ents = new Map<string, string[]>();
  for (const l of links) (ents.get(String(l.goal_id)) ?? ents.set(String(l.goal_id), []).get(String(l.goal_id))!).push(String(l.entity_ref));
  const all = rows.map((r) => rowToGoal(r, ents.get(String(r.id)) ?? []));
  const archivedIds = new Set(rows.filter((r) => Number(r.archived) === 1).map((r) => String(r.id)));
  const goals = all.filter((g) => !archivedIds.has(g.id));
  const archive = all.filter((g) => archivedIds.has(g.id)).sort((a, b) => (b.period ?? "").localeCompare(a.period ?? "") || (b.closed ?? "").localeCompare(a.closed ?? ""));
  const byLevel: Record<GoalLevel, number> = { L1: 0, L2: 0, L3: 0 };
  for (const g of goals) byLevel[g.level] += 1;
  const entityLinks: Record<string, string[]> = {};
  for (const g of all) if (g.entities?.length) entityLinks[g.id] = g.entities;
  const stamps = rows.map((r) => String(r.updated_at ?? "")).sort();
  const updatedAt = stamps[stamps.length - 1];
  return {
    goals,
    tree: buildGoalTree(goals),
    isEmpty: goals.length === 0,
    proposedCount: goals.filter((g) => g.status === "proposed").length,
    confirmedCount: goals.filter((g) => g.status !== "proposed" && g.status !== "unknown").length,
    byLevel,
    archive,
    periods: [...new Set(all.map((g) => g.period).filter((p): p is string => !!p))].sort().reverse(),
    entityLinks,
    identityMissing: false,
    updatedAt,
  };
}
