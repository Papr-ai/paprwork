/**
 * Workspace goals — the user's "big rocks" that the Daily Brief ranks against.
 *
 * Goals live in IDENTITY.md → `## Goals` (already injected into every agent
 * turn and maintained nightly by Sleep). This module parses that section into
 * structured records for the Home app, builds the L1 → L2 → L3 tree, and
 * reports validation problems (missing parents, overlapping L1s) so the UI
 * and Sleep can surface them instead of silently rendering a flat list.
 *
 * Block format (see workspace-templates/IDENTITY.md):
 *
 *   ### G1 — Close 2 channel-partner deals by Q4
 *   - Level: L1
 *   - Status: proposed
 *   - Confidence: high
 *   - Priority: 1
 *   - Parent: —
 *   - Next milestone: Send MSA to Justin (by 2026-09-12)
 *   - Owner: user
 *   - Evidence: > "…" — Chats/x.txt · mentions: 4 (30d)
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";

export type GoalStatus =
  | "proposed"
  | "on-track"
  | "at-risk"
  | "blocked"
  | "done"
  | "dropped"
  | "unknown";
export type GoalLevel = "L1" | "L2" | "L3";
export type GoalConfidence = "high" | "medium" | "low" | "unknown";

export interface WorkspaceGoal {
  id: string;
  title: string;
  status: GoalStatus;
  level: GoalLevel;
  confidence: GoalConfidence;
  /** Rank within the same level; lower is more important. Defaults to 99. */
  priority: number;
  /** Goal id this one advances (L2 → L1, L3 → L2). Undefined for L1. */
  parent?: string;
  nextMilestone?: string;
  owner?: string;
  evidence?: string;
  /** Quarter or year this goal belongs to, e.g. "2026-Q3" or "2026". */
  period?: string;
  opened?: string;
  closed?: string;
  /** One-line result, set when closed. */
  outcome?: string;
  /** Mention count parsed from Evidence ("mentions: 4 (30d)") when present. */
  mentions?: number;
  /** Wiki entity refs this goal runs through, e.g. ["projects/rr-partnership", "people/justin-jones"]. */
  entities?: string[];
  /** True when Parent names a goal that does not exist or is the wrong level. */
  parentMissing?: boolean;
}

export interface WorkspaceGoalNode extends WorkspaceGoal {
  children: WorkspaceGoalNode[];
}

export interface WorkspaceGoalsResult {
  goals: WorkspaceGoal[];
  /** L1 roots with nested L2 → L3 children, ordered by priority. */
  tree: WorkspaceGoalNode[];
  /** True when the section exists but has no goal blocks yet. */
  isEmpty: boolean;
  /** Goals Sleep drafted from evidence that the user has not confirmed yet. */
  proposedCount: number;
  /** Goals the user has confirmed (any status other than proposed/unknown). */
  confirmedCount: number;
  byLevel: Record<GoalLevel, number>;
  /** Closed goals from workspace/goals/archive.md, newest period first. */
  archive: WorkspaceGoal[];
  /** Distinct periods seen across active + archived goals, newest first. */
  periods: string[];
  /** Goal → entity refs declared on the goal side (entity-side links live in the goal_entities table). */
  entityLinks: Record<string, string[]>;
  /** True when IDENTITY.md is missing entirely. */
  identityMissing: boolean;
  /** ISO mtime of IDENTITY.md when available. */
  updatedAt?: string;
}

const STATUS_VALUES: ReadonlySet<string> = new Set([
  "proposed",
  "on-track",
  "at-risk",
  "blocked",
  "done",
  "dropped",
]);
const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const LEVEL_PARENT: Record<GoalLevel, GoalLevel | null> = {
  L1: null,
  L2: "L1",
  L3: "L2",
};

function identityPath(): string {
  return path.join(getPaprWorkspaceDir(), "IDENTITY.md");
}

function archivePath(): string {
  return path.join(getPaprWorkspaceDir(), "goals", "archive.md");
}

/** Archive blocks live under `## <Period>` headings; parse all of them, tagging period from the heading when the block lacks one. */
export function parseArchive(markdown: string): WorkspaceGoal[] {
  const out: WorkspaceGoal[] = [];
  const parts = markdown.split(/^(?=## )/m);
  for (const part of parts) {
    const head = part.match(/^## ([^\n]+)/);
    if (!head) continue;
    const period = head[1].trim();
    for (const g of parseGoals(part.slice(head[0].length))) {
      out.push({ ...g, period: g.period ?? period });
    }
  }
  return out;
}

function periodSortKey(p: string): string {
  // "2026-Q3" → "2026-3", "2026" → "2026-9" so a year sorts after its quarters.
  const m = p.match(/^(\d{4})(?:-Q([1-4]))?$/);
  return m ? `${m[1]}-${m[2] ?? "9"}` : p;
}

/** Extract the raw body of `## Goals` (up to the next `## ` heading). */
export function extractGoalsSection(identity: string): string | null {
  const start = identity.search(/^## Goals[^\n]*\n/m);
  if (start < 0) return null;
  const afterHeading = identity.indexOf("\n", start) + 1;
  const rest = identity.slice(afterHeading);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

function normalizeStatus(raw: string | undefined): GoalStatus {
  const v = raw?.trim().toLowerCase().replace(/\s+/g, "-");
  return v && STATUS_VALUES.has(v) ? (v as GoalStatus) : "unknown";
}

function normalizeConfidence(raw: string | undefined): GoalConfidence {
  const v = raw?.trim().toLowerCase();
  if (!v) return "unknown";
  if (v.startsWith("med")) return "medium";
  return CONFIDENCE_VALUES.has(v) ? (v as GoalConfidence) : "unknown";
}

function normalizeLevel(raw: string | undefined): GoalLevel | null {
  const m = raw?.trim().toUpperCase().match(/^L([123])\b/);
  return m ? (`L${m[1]}` as GoalLevel) : null;
}

/** "projects/x, people/y-z; companies/acme" → ["projects/x", "people/y-z", "companies/acme"]. Bare slugs without a type are dropped. */
export function parseEntityRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const m = part.trim().replace(/^`|`$/g, "").match(/^([a-z]+)\/([a-z0-9][a-z0-9-]*)$/i);
    if (m) out.push(`${m[1].toLowerCase()}/${m[2].toLowerCase()}`);
  }
  return [...new Set(out)];
}

function normalizeParent(raw: string | undefined): string | undefined {
  const m = raw?.trim().match(/\b(G\d+)\b/);
  return m ? m[1] : undefined;
}

/** "G1 — Title (Parent: G3)" → id, cleaned title, optional parent from the heading suffix. */
function parseGoalHeading(raw: string): { id: string; title: string; parent?: string } | null {
  const headMatch = raw.match(/^(G\d+)\s*[—–-]\s*(.+)$/);
  if (!headMatch) return null;
  let title = headMatch[2].trim();
  const parentInTitle = title.match(/\((?:Parent:\s*)(G\d+)\)\s*$/i);
  const parent = parentInTitle ? parentInTitle[1] : undefined;
  if (parentInTitle) title = title.replace(/\s*\((?:Parent:\s*)G\d+\)\s*$/i, "").trim();
  return { id: headMatch[1], title, parent };
}

/** Parse goal blocks out of the `## Goals` body. Fenced code (the template example) is ignored. */
export function parseGoals(sectionBody: string): WorkspaceGoal[] {
  const withoutFences = sectionBody.replace(/```[\s\S]*?```/g, "");
  // L1 blocks use `###`; Sleep sometimes nests L2/L3 under an L1 with `####` — each heading is its own goal.
  const blocks = withoutFences.split(/^(?=#{3,4} )/m).filter((b) => /^#{3,4} /.test(b));
  const goals: WorkspaceGoal[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const heading = lines[0].replace(/^#{3,4}\s*/, "").trim();
    const parsedHeading = parseGoalHeading(heading);
    if (!parsedHeading) continue;
    const goal: WorkspaceGoal = {
      id: parsedHeading.id,
      title: parsedHeading.title,
      status: "unknown",
      level: "L1",
      confidence: "unknown",
      priority: 99,
      parent: parsedHeading.parent,
    };
    let explicitLevel: GoalLevel | null = null;
    for (const line of lines.slice(1)) {
      const kv = line.match(/^\s*-\s*([A-Za-z ]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].trim();
      if (key === "status") goal.status = normalizeStatus(value);
      else if (key === "level") explicitLevel = normalizeLevel(value);
      else if (key === "confidence") goal.confidence = normalizeConfidence(value);
      else if (key === "priority") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) goal.priority = n;
      } else if (key === "parent") goal.parent = normalizeParent(value);
      else if (key === "next milestone") goal.nextMilestone = value || undefined;
      else if (key === "entities") {
        const refs = parseEntityRefs(value);
        if (refs.length) goal.entities = refs;
      } else if (key === "period") goal.period = value.replace(/^[—–-]+$/, "") || undefined;
      else if (key === "opened") goal.opened = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      else if (key === "closed") goal.closed = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      else if (key === "outcome") goal.outcome = value.replace(/^\(only when closed[^)]*\)$/, "") || undefined;
      else if (key === "owner") goal.owner = value || undefined;
      else if (key === "evidence") {
        goal.evidence = value || undefined;
        const mm = value.match(/mentions:\s*(\d+)/i);
        if (mm) goal.mentions = Number.parseInt(mm[1], 10);
      }
    }
    // Level: explicit wins; otherwise infer from parent presence (legacy blocks are L1).
    goal.level = explicitLevel ?? (goal.parent ? "L2" : "L1");
    if (goal.level === "L1") goal.parent = undefined;
    goals.push(goal);
  }
  // Validate parent links: must exist and be exactly one level up.
  const byId = new Map(goals.map((g) => [g.id, g]));
  for (const g of goals) {
    if (g.level === "L1") continue;
    const parent = g.parent ? byId.get(g.parent) : undefined;
    if (!parent || parent.level !== LEVEL_PARENT[g.level]) g.parentMissing = true;
  }
  return goals;
}

function sortByPriority<T extends WorkspaceGoal>(list: T[]): T[] {
  return [...list].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Build L1 → L2 → L3 tree. Orphans (parentMissing) are attached under a synthetic root so they still render. */
export function buildGoalTree(goals: WorkspaceGoal[]): WorkspaceGoalNode[] {
  const nodes = new Map<string, WorkspaceGoalNode>();
  for (const g of goals) nodes.set(g.id, { ...g, children: [] });
  const roots: WorkspaceGoalNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent && !node.parentMissing ? nodes.get(node.parent) : undefined;
    if (node.level === "L1" || !parent) roots.push(node);
    else parent.children.push(node);
  }
  const sortDeep = (list: WorkspaceGoalNode[]): WorkspaceGoalNode[] =>
    sortByPriority(list).map((n) => ({ ...n, children: sortDeep(n.children) }));
  return sortDeep(roots);
}

export async function readWorkspaceGoals(): Promise<WorkspaceGoalsResult> {
  const file = identityPath();
  const empty: WorkspaceGoalsResult = {
    goals: [],
    tree: [],
    isEmpty: true,
    proposedCount: 0,
    confirmedCount: 0,
    byLevel: { L1: 0, L2: 0, L3: 0 },
    archive: [],
    periods: [],
    entityLinks: {},
    identityMissing: false,
  };
  let identity: string;
  let updatedAt: string | undefined;
  try {
    identity = await fs.readFile(file, "utf8");
    const stat = await fs.stat(file);
    updatedAt = stat.mtime.toISOString();
  } catch {
    return { ...empty, identityMissing: true };
  }
  const section = extractGoalsSection(identity);
  const goals = section ? parseGoals(section) : [];
  const byLevel: Record<GoalLevel, number> = { L1: 0, L2: 0, L3: 0 };
  for (const g of goals) byLevel[g.level] += 1;
  let archive: WorkspaceGoal[] = [];
  try {
    archive = parseArchive(await fs.readFile(archivePath(), "utf8"));
  } catch {
    /* no archive yet */
  }
  const periods = [...new Set([...goals, ...archive].map((g) => g.period).filter((p): p is string => !!p))]
    .sort((a, b) => periodSortKey(b).localeCompare(periodSortKey(a)));
  archive.sort((a, b) => periodSortKey(b.period ?? "").localeCompare(periodSortKey(a.period ?? "")) || (b.closed ?? "").localeCompare(a.closed ?? ""));
  const entityLinks: Record<string, string[]> = {};
  for (const g of [...goals, ...archive]) if (g.entities?.length) entityLinks[g.id] = g.entities;
  return {
    archive,
    periods,
    entityLinks,
    goals,
    tree: buildGoalTree(goals),
    isEmpty: goals.length === 0,
    proposedCount: goals.filter((g) => g.status === "proposed").length,
    confirmedCount: goals.filter((g) => g.status !== "proposed" && g.status !== "unknown").length,
    byLevel,
    identityMissing: false,
    updatedAt,
  };
}
