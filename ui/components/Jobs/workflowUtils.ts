import type { JobGraph, JobRecord } from "../../hooks/useJobs";

export const NODE_W = 220;
export const NODE_H = 76;
export const APP_NODE_W = 240;
export const APP_NODE_H = 88;
export const COL_GAP = 120;
export const ROW_GAP = 28;
export const CANVAS_PAD = 48;

export interface NodePosition {
  id: string;
  x: number;
  y: number;
  kind: "job" | "app";
}

export interface WorkflowEdge {
  from: string;
  to: string;
  onStatus: "completed" | "failed";
  isRuntimeCall?: boolean;
  autoTrigger?: boolean;
  isDataLink?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  python: "#3776ab",
  node: "#68a063",
  bash: "#4b5563",
  shell: "#4b5563",
  swift: "#f05138",
  agent: "#8b5cf6",
  subagent: "#a855f7",
};

export function jobTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? "#6b7280";
}

export function collectWorkflowJobIds(
  seedJobIds: string[],
  allJobs: JobRecord[],
  edges: JobGraph["edges"],
  allowedJobIds?: Set<string>,
): Set<string> {
  const seeds = allowedJobIds
    ? seedJobIds.filter((id) => allowedJobIds.has(id))
    : seedJobIds;
  const included = new Set<string>(seeds);
  const queue = [...seeds];

  while (queue.length > 0) {
    const jobId = queue.shift();
    if (!jobId) continue;

    const job = allJobs.find((j) => j.id === jobId);
    for (const dep of job?.dependsOn ?? []) {
      if (allowedJobIds && !allowedJobIds.has(dep.jobId)) {
        continue;
      }
      if (!included.has(dep.jobId)) {
        included.add(dep.jobId);
        queue.push(dep.jobId);
      }
    }

    for (const edge of edges) {
      if (edge.to !== jobId) continue;
      if (allowedJobIds && !allowedJobIds.has(edge.from)) {
        continue;
      }
      if (!included.has(edge.from)) {
        included.add(edge.from);
        queue.push(edge.from);
      }
    }
  }

  return included;
}

export function buildWorkflowEdges(
  workflowJobs: JobRecord[],
  graph: JobGraph,
  linkedJobIds: Set<string>,
  appId: string,
): WorkflowEdge[] {
  const jobIds = new Set(workflowJobs.map((j) => j.id));
  const edges: WorkflowEdge[] = [];

  for (const edge of graph.edges) {
    if (jobIds.has(edge.from) && jobIds.has(edge.to)) {
      edges.push({
        from: edge.from,
        to: edge.to,
        onStatus: edge.onStatus,
        isRuntimeCall: edge.isRuntimeCall,
        autoTrigger: edge.autoTrigger,
      });
    }
  }

  for (const jobId of linkedJobIds) {
    if (jobIds.has(jobId)) {
      edges.push({
        from: jobId,
        to: `app:${appId}`,
        onStatus: "completed",
        isDataLink: true,
      });
    }
  }

  return edges;
}

export function buildStandaloneEdges(
  workflowJobs: JobRecord[],
  graph: JobGraph,
): WorkflowEdge[] {
  const jobIds = new Set(workflowJobs.map((j) => j.id));
  const edges: WorkflowEdge[] = [];

  for (const edge of graph.edges) {
    if (jobIds.has(edge.from) && jobIds.has(edge.to)) {
      edges.push({
        from: edge.from,
        to: edge.to,
        onStatus: edge.onStatus,
        isRuntimeCall: edge.isRuntimeCall,
        autoTrigger: edge.autoTrigger,
      });
    }
  }

  return edges;
}

export function computeWorkflowLayout(
  jobs: JobRecord[],
  edges: WorkflowEdge[],
  appId?: string,
): NodePosition[] {
  if (jobs.length === 0) {
    if (appId) {
      return [
        {
          id: `app:${appId}`,
          x: CANVAS_PAD,
          y: CANVAS_PAD,
          kind: "app",
        },
      ];
    }
    return [];
  }

  const jobIds = new Set(jobs.map((j) => j.id));
  const visibleEdges = edges.filter(
    (e) =>
      !e.isDataLink &&
      jobIds.has(e.from) &&
      (jobIds.has(e.to) || e.to.startsWith("app:")),
  );

  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();

  for (const job of jobs) {
    inDeg.set(job.id, 0);
    outAdj.set(job.id, []);
  }

  for (const edge of visibleEdges) {
    if (edge.to.startsWith("app:")) continue;
    inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1);
    const list = outAdj.get(edge.from) ?? [];
    list.push(edge.to);
    outAdj.set(edge.from, list);
  }

  const levels = new Map<string, number>();
  const queue: Array<{ id: string; level: number }> = [];

  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push({ id, level: 0 });
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;
    const existing = levels.get(item.id) ?? -1;
    if (item.level <= existing) continue;
    levels.set(item.id, item.level);
    for (const nextId of outAdj.get(item.id) ?? []) {
      queue.push({ id: nextId, level: item.level + 1 });
    }
  }

  for (const job of jobs) {
    if (!levels.has(job.id)) levels.set(job.id, 0);
  }

  const byLevel = new Map<number, JobRecord[]>();
  for (const job of jobs) {
    const level = levels.get(job.id) ?? 0;
    const group = byLevel.get(level) ?? [];
    group.push(job);
    byLevel.set(level, group);
  }

  for (const group of byLevel.values()) {
    group.sort((a, b) => a.name.localeCompare(b.name));
  }

  const positions: NodePosition[] = [];
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const maxLevel = sortedLevels.length > 0 ? Math.max(...sortedLevels) : 0;

  for (const level of sortedLevels) {
    const group = byLevel.get(level) ?? [];
    group.forEach((job, rowIndex) => {
      positions.push({
        id: job.id,
        x: CANVAS_PAD + level * (NODE_W + COL_GAP),
        y: CANVAS_PAD + rowIndex * (NODE_H + ROW_GAP),
        kind: "job",
      });
    });
  }

  if (appId) {
    const maxY = positions.reduce((max, p) => Math.max(max, p.y), CANVAS_PAD);
    const appCol = CANVAS_PAD + (maxLevel + 1) * (NODE_W + COL_GAP);

    positions.push({
      id: `app:${appId}`,
      x: appCol,
      y: maxY,
      kind: "app",
    });
  }

  return positions;
}

export function getCanvasSize(
  positions: NodePosition[],
  minWidth = 0,
): { width: number; height: number } {
  if (positions.length === 0) {
    return { width: Math.max(minWidth, 600), height: 400 };
  }

  let maxX = 0;
  let maxY = 0;

  for (const pos of positions) {
    const w = pos.kind === "app" ? APP_NODE_W : NODE_W;
    const h = pos.kind === "app" ? APP_NODE_H : NODE_H;
    maxX = Math.max(maxX, pos.x + w);
    maxY = Math.max(maxY, pos.y + h);
  }

  return {
    width: Math.max(minWidth, maxX + CANVAS_PAD),
    height: maxY + CANVAS_PAD,
  };
}

export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
}
