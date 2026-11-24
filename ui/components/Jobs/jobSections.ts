/**
 * Groups an app's jobs into the three ways they start, for the app's Jobs panel:
 *
 *   Scheduled — a chain whose first job runs on a schedule
 *   One off   — everything else: run by hand, or by the app itself
 *
 * A chain is a set of jobs joined by any edge (runs after, runs if it fails,
 * called while running). Each chain lands in exactly one section, so a job is
 * never drawn twice. Within a section, column = depth in the chain and rows fill
 * top-down per column — the same rule as computeWorkflowLayout.
 */

import type { JobGraph, JobRecord } from "../../hooks/useJobs";
import { jobTriggerKind, scheduleSortMinutes } from "../../utils/jobTriggerLabel";

export type JobSectionId = "scheduled" | "oneOff";

export type JobEdgeKind = "dep" | "failed" | "runtime";

export interface SectionEdge {
  from: string;
  to: string;
  kind: JobEdgeKind;
}

export interface JobSection {
  id: JobSectionId;
  jobs: JobRecord[];
  edges: SectionEdge[];
}

export interface CardDims {
  w: number;
  h: number;
  col: number;
  row: number;
  pad: number;
}

/** Full width: the live card, narrower and packed closer. */
export const WIDE_CARD: CardDims = { w: 196, h: 62, col: 44, row: 12, pad: 18 };
/** Beside the app (460px panel): name + trigger only. */
export const NARROW_CARD: CardDims = { w: 110, h: 50, col: 18, row: 10, pad: 12 };

const SECTION_ORDER: JobSectionId[] = ["scheduled", "oneOff"];

function edgeKind(edge: JobGraph["edges"][number]): JobEdgeKind {
  if (edge.isRuntimeCall) return "runtime";
  return edge.onStatus === "failed" ? "failed" : "dep";
}

/** Edges between the given jobs: graph edges plus any dependsOn the graph has not caught up with. */
export function collectSectionEdges(
  jobs: JobRecord[],
  graphEdges: JobGraph["edges"],
): SectionEdge[] {
  const ids = new Set(jobs.map((j) => j.id));
  const seen = new Set<string>();
  const out: SectionEdge[] = [];
  const push = (e: SectionEdge): void => {
    const key = `${e.from}>${e.to}`;
    if (seen.has(key) || e.from === e.to) return;
    seen.add(key);
    out.push(e);
  };
  for (const edge of graphEdges) {
    if (ids.has(edge.from) && ids.has(edge.to)) {
      push({ from: edge.from, to: edge.to, kind: edgeKind(edge) });
    }
  }
  for (const job of jobs) {
    for (const dep of job.dependsOn ?? []) {
      if (ids.has(dep.jobId)) {
        push({ from: dep.jobId, to: job.id, kind: dep.onStatus === "failed" ? "failed" : "dep" });
      }
    }
  }
  return out;
}

function compareRoots(a: JobRecord, b: JobRecord): number {
  const sa = jobTriggerKind(a) === "scheduled" ? scheduleSortMinutes(a) : 9999;
  const sb = jobTriggerKind(b) === "scheduled" ? scheduleSortMinutes(b) : 9999;
  return sa - sb || a.name.localeCompare(b.name);
}

export function groupJobSections(
  jobs: JobRecord[],
  graphEdges: JobGraph["edges"],
): JobSection[] {
  const edges = collectSectionEdges(jobs, graphEdges);
  const byId = new Map(jobs.map((j) => [j.id, j]));

  // Union-find over every edge kind: a chain is one connected component.
  const parent = new Map(jobs.map((j) => [j.id, j.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const e of edges) parent.set(find(e.from), find(e.to));

  const chains = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const root = find(job.id);
    chains.set(root, [...(chains.get(root) ?? []), job]);
  }

  const hasIncoming = new Set(edges.map((e) => e.to));
  const buckets: Record<JobSectionId, JobRecord[][]> = { scheduled: [], oneOff: [] };
  for (const chain of chains.values()) {
    const starts = chain.filter((j) => !hasIncoming.has(j.id));
    const entry = starts.length > 0 ? starts : chain;
    const section: JobSectionId = entry.some((j) => jobTriggerKind(j) === "scheduled")
      ? "scheduled"
      : "oneOff";
    buckets[section].push(chain);
  }

  return SECTION_ORDER.filter((id) => buckets[id].length > 0).map((id) => {
    const chainsSorted = buckets[id]
      .map((chain) => ({ chain, first: [...chain].sort(compareRoots)[0] }))
      .sort((a, b) => compareRoots(a.first, b.first))
      .flatMap(({ chain }) => chain);
    const ids = new Set(chainsSorted.map((j) => j.id));
    return {
      id,
      jobs: chainsSorted.filter((j) => byId.has(j.id)),
      edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
  });
}

export interface CardPosition {
  x: number;
  y: number;
}

/** Column = longest path from a chain start; rows fill top-down per column. */
export function layoutSection(
  section: JobSection,
  dims: CardDims,
  /** Unconnected jobs (no edges in the section) wrap into this many columns. */
  wrapCols = 3,
): { positions: Map<string, CardPosition>; width: number; height: number } {
  const incoming = new Map<string, string[]>();
  for (const e of section.edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }
  const depthCache = new Map<string, number>();
  const depth = (id: string, trail: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 0; // cycle guard
    trail.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depth(p, trail)));
    trail.delete(id);
    depthCache.set(id, d);
    return d;
  };

  const rowsUsed: number[] = [];
  const positions = new Map<string, CardPosition>();
  let maxX = 0;
  let maxY = 0;
  const flat = section.edges.length === 0;
  section.jobs.forEach((job, index) => {
    let col: number;
    let row: number;
    if (flat) {
      col = index % Math.max(1, wrapCols);
      row = Math.floor(index / Math.max(1, wrapCols));
    } else {
      col = depth(job.id, new Set());
      row = rowsUsed[col] = (rowsUsed[col] ?? -1) + 1;
    }
    const x = dims.pad + 6 + col * (dims.w + dims.col);
    const y = dims.pad + row * (dims.h + dims.row);
    positions.set(job.id, { x, y });
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return {
    positions,
    width: maxX + dims.w + dims.pad + 6,
    height: maxY + dims.h + dims.pad,
  };
}
