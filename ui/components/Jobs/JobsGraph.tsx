import { useMemo } from "react";
import type { JobGraph, JobRecord } from "../../hooks/useJobs";
import "./JobsGraph.css";

interface JobsGraphProps {
  jobs: JobRecord[];
  graph: JobGraph;
  selectedJobId: string | null;
  onJobClick: (jobId: string) => void;
}

const NODE_W = 190;
const NODE_H = 60;
const COL_STRIDE = NODE_W + 90;
const ROW_STRIDE = NODE_H + 24;
const PADDING = 40;
const CLUSTER_PAD_X = 14;
const CLUSTER_PAD_Y = 26;

interface NodePos {
  id: string;
  x: number;
  y: number;
}

function computeLayout(jobs: JobRecord[], edges: JobGraph["edges"]): NodePos[] {
  if (jobs.length === 0) return [];

  const jobIds = new Set(jobs.map((j) => j.id));
  const visibleEdges = edges.filter((e) => jobIds.has(e.from) && jobIds.has(e.to));

  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  for (const job of jobs) {
    inDeg.set(job.id, 0);
    outAdj.set(job.id, []);
  }
  for (const edge of visibleEdges) {
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
    const item = queue.shift()!;
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
    group.sort((a, b) => {
      const fa = a.folder ?? "";
      const fb = b.folder ?? "";
      if (fa !== fb) return fa.localeCompare(fb);
      return a.name.localeCompare(b.name);
    });
  }

  const positions: NodePos[] = [];
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const group = byLevel.get(level)!;
    let y = 0;
    let lastFolder: string | undefined = undefined;
    for (const job of group) {
      // Add a gap when transitioning between folder groups within the same column
      if (lastFolder !== undefined && job.folder !== lastFolder) {
        y += ROW_STRIDE * 0.6;
      }
      positions.push({
        id: job.id,
        x: PADDING + level * COL_STRIDE,
        y: PADDING + y,
      });
      y += ROW_STRIDE;
      lastFolder = job.folder;
    }
  }
  return positions;
}

const STATUS_COLOR: Record<string, string> = {
  running: "#10b981",
  completed: "#3b82f6",
  failed: "#ef4444",
  cancelled: "#f59e0b",
  pending: "#9ca3af",
};

const TYPE_LABEL: Record<string, string> = {
  python: "py",
  node: "js",
  shell: "sh",
  bash: "sh",
  swift: "swift",
  agent: "ai",
  subagent: "ai",
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function JobsGraph({ jobs, graph, selectedJobId, onJobClick }: JobsGraphProps) {
  const positions = useMemo(() => computeLayout(jobs, graph.edges), [jobs, graph.edges]);

  const posMap = useMemo(() => {
    const m = new Map<string, NodePos>();
    for (const pos of positions) m.set(pos.id, pos);
    return m;
  }, [positions]);

  const jobMap = useMemo(() => {
    const m = new Map<string, JobRecord>();
    for (const job of jobs) m.set(job.id, job);
    return m;
  }, [jobs]);

  const jobIds = useMemo(() => new Set(jobs.map((j) => j.id)), [jobs]);

  const visibleEdges = useMemo(
    () => graph.edges.filter((e) => jobIds.has(e.from) && jobIds.has(e.to)),
    [graph.edges, jobIds],
  );

  const clusters = useMemo(() => {
    const result: Array<{ folder: string; x: number; y: number; w: number; h: number }> = [];
    for (const [folder, folderJobIds] of Object.entries(graph.folders)) {
      // Group nodes in this folder by their column (x position) to draw one box per column
      const byColumn = new Map<number, NodePos[]>();
      for (const id of folderJobIds) {
        const pos = posMap.get(id);
        if (!pos) continue;
        const col = pos.x;
        const group = byColumn.get(col) ?? [];
        group.push(pos);
        byColumn.set(col, group);
      }
      for (const nodes of byColumn.values()) {
        if (nodes.length === 0) continue;
        const ys = nodes.map((n) => n.y);
        const colX = nodes[0].x;
        result.push({
          folder,
          x: colX - CLUSTER_PAD_X,
          y: Math.min(...ys) - CLUSTER_PAD_Y,
          w: NODE_W + CLUSTER_PAD_X * 2,
          h: Math.max(...ys) + NODE_H + CLUSTER_PAD_X - (Math.min(...ys) - CLUSTER_PAD_Y),
        });
      }
    }
    return result;
  }, [graph.folders, posMap]);

  if (jobs.length === 0) {
    return (
      <div className="jobs-graph-empty">
        <p>No jobs to display</p>
      </div>
    );
  }

  const svgWidth = Math.max(...positions.map((p) => p.x + NODE_W)) + PADDING;
  const svgHeight = Math.max(...positions.map((p) => p.y + NODE_H)) + PADDING;

  return (
    <div className="jobs-graph-scroll">
      <svg
        className="jobs-graph-svg"
        width={svgWidth}
        height={svgHeight}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <marker
            id="jg-arrow-default"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" className="jg-arrow-default" />
          </marker>
          <marker
            id="jg-arrow-completed"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#3b82f6" />
          </marker>
          <marker
            id="jg-arrow-failed"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#ef4444" />
          </marker>
        </defs>

        {/* Folder cluster backgrounds */}
        {clusters.map((cluster) => (
          <g key={cluster.folder}>
            <rect
              x={cluster.x}
              y={cluster.y}
              width={cluster.w}
              height={cluster.h}
              rx={10}
              className="jg-cluster-rect"
            />
            <text x={cluster.x + 10} y={cluster.y + 16} className="jg-cluster-label">
              {cluster.folder}
            </text>
          </g>
        ))}

        {/* Dependency edges */}
        {visibleEdges.map((edge, i) => {
          const src = posMap.get(edge.from);
          const dst = posMap.get(edge.to);
          if (!src || !dst) return null;
          const x1 = src.x + NODE_W;
          const y1 = src.y + NODE_H / 2;
          const x2 = dst.x;
          const y2 = dst.y + NODE_H / 2;
          const cx = (x1 + x2) / 2;
          const isCompleted = edge.onStatus === "completed";
          const edgeColor = isCompleted ? "#3b82f6" : "#ef4444";
          const arrowId = isCompleted ? "jg-arrow-completed" : "jg-arrow-failed";
          const labelX = (x1 + x2) / 2;
          const labelY = (y1 + y2) / 2 - 6;
          return (
            <g key={i}>
              <path
                d={`M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke={edgeColor}
                strokeWidth={1.5}
                strokeOpacity={0.55}
                markerEnd={`url(#${arrowId})`}
              />
              <text
                x={labelX}
                y={labelY}
                textAnchor="middle"
                className="jg-edge-label"
                fill={edgeColor}
              >
                {edge.onStatus}
              </text>
            </g>
          );
        })}

        {/* Job nodes */}
        {positions.map((pos) => {
          const job = jobMap.get(pos.id);
          if (!job) return null;
          const statusColor = STATUS_COLOR[job.status] ?? "#9ca3af";
          const isSelected = pos.id === selectedJobId;
          const typeLabel = TYPE_LABEL[job.type] ?? job.type;
          return (
            <g
              key={pos.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onJobClick(pos.id)}
              className="jg-node-group"
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={isSelected ? "jg-node jg-node--selected" : "jg-node"}
              />
              {/* Status dot */}
              <circle cx={14} cy={NODE_H / 2} r={4} fill={statusColor} />
              {/* Job name */}
              <text x={26} y={NODE_H / 2 - 6} className="jg-node-name">
                {truncate(job.name, 21)}
              </text>
              {/* Type · status */}
              <text x={26} y={NODE_H / 2 + 10} className="jg-node-meta">
                {typeLabel} · {job.status}
              </text>
              {/* Folder badge (if no cluster shown) */}
              {job.folder && clusters.every((c) => c.folder !== job.folder) && (
                <text x={NODE_W - 6} y={NODE_H - 8} textAnchor="end" className="jg-node-folder">
                  {truncate(job.folder, 12)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
