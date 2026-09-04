/**
 * Workspace goals — the user's "big rocks" that the Daily Brief ranks against.
 *
 * Goals live in IDENTITY.md → `## Goals` (already injected into every agent
 * turn and maintained nightly by Sleep). This module parses that section into
 * structured records for the Home app and reports whether it is still the
 * template placeholder so the UI can prompt the user to set goals.
 *
 * Expected block format (see workspace-templates/IDENTITY.md):
 *
 *   ### G1 — Close 2 channel-partner deals by Q4
 *   - Status: on-track
 *   - Next milestone: Send MSA to Justin (by 2026-09-12)
 *   - Owner: user
 *   - Evidence: chat "RR partnership" 2026-08-26
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";

export type GoalStatus = "on-track" | "at-risk" | "blocked" | "done" | "unknown";

export interface WorkspaceGoal {
  id: string;
  title: string;
  status: GoalStatus;
  nextMilestone?: string;
  owner?: string;
  evidence?: string;
}

export interface WorkspaceGoalsResult {
  goals: WorkspaceGoal[];
  /** True when the section exists but has no goal blocks yet. */
  isEmpty: boolean;
  /** True when IDENTITY.md is missing entirely. */
  identityMissing: boolean;
  /** ISO mtime of IDENTITY.md when available. */
  updatedAt?: string;
}

const STATUS_VALUES: ReadonlySet<string> = new Set([
  "on-track",
  "at-risk",
  "blocked",
  "done",
]);

function identityPath(): string {
  return path.join(getPaprWorkspaceDir(), "IDENTITY.md");
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

/** Parse goal blocks out of the `## Goals` body. Fenced code (the template example) is ignored. */
export function parseGoals(sectionBody: string): WorkspaceGoal[] {
  const withoutFences = sectionBody.replace(/```[\s\S]*?```/g, "");
  const blocks = withoutFences.split(/^(?=### )/m).filter((b) => b.startsWith("### "));
  const goals: WorkspaceGoal[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const heading = lines[0].replace(/^###\s*/, "").trim();
    const headMatch = heading.match(/^(G\d+)\s*[—–-]\s*(.+)$/);
    if (!headMatch) continue;
    const goal: WorkspaceGoal = {
      id: headMatch[1],
      title: headMatch[2].trim(),
      status: "unknown",
    };
    for (const line of lines.slice(1)) {
      const kv = line.match(/^\s*-\s*([A-Za-z ]+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].trim();
      if (key === "status") goal.status = normalizeStatus(value);
      else if (key === "next milestone") goal.nextMilestone = value;
      else if (key === "owner") goal.owner = value;
      else if (key === "evidence") goal.evidence = value;
    }
    goals.push(goal);
  }
  return goals;
}

export async function readWorkspaceGoals(): Promise<WorkspaceGoalsResult> {
  const file = identityPath();
  let identity: string;
  let updatedAt: string | undefined;
  try {
    identity = await fs.readFile(file, "utf8");
    const stat = await fs.stat(file);
    updatedAt = stat.mtime.toISOString();
  } catch {
    return { goals: [], isEmpty: true, identityMissing: true };
  }
  const section = extractGoalsSection(identity);
  const goals = section ? parseGoals(section) : [];
  return { goals, isEmpty: goals.length === 0, identityMissing: false, updatedAt };
}
