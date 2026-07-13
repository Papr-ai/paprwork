import { useEffect, useMemo, useRef, useState } from "react";
import type { JobGraph, JobRecord } from "../../hooks/useJobs";
import { JobTypeIcon } from "../../utils/jobTypeIcon";
import { renderAppIcon } from "../../utils/renderAppIcon";
import {
  APP_NODE_H,
  APP_NODE_W,
  NODE_H,
  NODE_W,
  buildStandaloneEdges,
  buildWorkflowEdges,
  collectWorkflowJobIds,
  computeWorkflowLayout,
  edgePath,
  getCanvasSize,
  jobTypeColor,
  type NodePosition,
  type WorkflowEdge,
} from "./workflowUtils";
import "./AppWorkflow.css";

interface AppWorkflowProps {
  appId: string;
  appName: string;
  appIcon?: string;
  jobs: JobRecord[];
  graph: JobGraph;
  selectedJobId: string | null;
  onJobSelect: (jobId: string) => void;
  onCanvasClick?: () => void;
  onRunJob: (jobId: string) => void;
  onStopJob: (jobId: string) => void;
  triggerLabel: (job: JobRecord) => string;
  /** When set, renders jobs from these seeds instead of app data-source links */
  seedJobIds?: string[];
  /** When set, dependency expansion cannot pull in jobs outside this set */
  restrictToJobIds?: string[];
  showAppNode?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  python: "Python",
  node: "Node.js",
  shell: "Shell",
  bash: "Bash",
  swift: "Swift",
  agent: "Agent",
  subagent: "Sub-agent",
};

const STATUS_CLASS: Record<string, string> = {
  running: "wf-status--running",
  completed: "wf-status--completed",
  failed: "wf-status--failed",
  waiting_permission: "wf-status--waiting",
  cancelled: "wf-status--cancelled",
  pending: "wf-status--pending",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function JobNodeCard({
  job,
  position,
  isSelected,
  trigger,
  onSelect,
  onRun,
  onStop,
}: {
  job: JobRecord;
  position: NodePosition;
  isSelected: boolean;
  trigger: string;
  onSelect: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const isActive =
    job.status === "running" || job.status === "waiting_permission";
  const typeColor = jobTypeColor(job.type);
  const typeLabel = TYPE_LABEL[job.type] ?? job.type;
  const statusClass = STATUS_CLASS[job.status] ?? "wf-status--pending";

  return (
    <div
      className={`wf-node wf-node--job ${isSelected ? "wf-node--selected" : ""}`}
      style={{
        left: position.x,
        top: position.y,
        width: NODE_W,
        height: NODE_H,
        ["--wf-type-color" as string]: typeColor,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <div className="wf-node-port wf-node-port--in" />
      <div className="wf-node-body">
        <div className="wf-node-header">
          <span className={`wf-node-type-icon ${statusClass}`}>
            <JobTypeIcon type={job.type} size={14} />
          </span>
          <span className="wf-node-title">{truncate(job.name, 24)}</span>
        </div>
        <div className="wf-node-meta">
          <span className="wf-node-type">{typeLabel}</span>
          {trigger && <span className="wf-node-trigger">{truncate(trigger, 18)}</span>}
        </div>
      </div>
      <button
        className="wf-node-action"
        title={isActive ? "Stop" : "Run"}
        onClick={(e) => {
          e.stopPropagation();
          if (isActive) onStop();
          else onRun();
        }}
      >
        {isActive ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
            <rect x="6" y="6" width="12" height="12" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
            <path d="M8 5v14l11-7-11-7z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="wf-node-port wf-node-port--out" />
    </div>
  );
}

function AppNodeCard({
  appName,
  appIcon,
  position,
  jobCount,
}: {
  appName: string;
  appIcon?: string;
  position: NodePosition;
  jobCount: number;
}) {
  return (
    <div
      className="wf-node wf-node--app"
      style={{
        left: position.x,
        top: position.y,
        width: APP_NODE_W,
        height: APP_NODE_H,
      }}
    >
      <div className="wf-node-port wf-node-port--in" />
      <div className="wf-app-body">
        <div className="wf-app-icon-wrap">
          {renderAppIcon(appIcon, { size: 20, className: "wf-app-icon-svg" })}
        </div>
        <div className="wf-app-info">
          <span className="wf-app-label">Mini App</span>
          <span className="wf-app-title">{truncate(appName, 22)}</span>
          <span className="wf-app-meta">
            {jobCount} data source{jobCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AppWorkflow({
  appId,
  appName,
  appIcon,
  jobs,
  graph,
  selectedJobId,
  onJobSelect,
  onCanvasClick,
  onRunJob,
  onStopJob,
  triggerLabel,
  seedJobIds,
  restrictToJobIds,
  showAppNode = true,
}: AppWorkflowProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateWidth = (): void => {
      setViewportWidth(element.clientWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const allowedJobIds = useMemo(
    () =>
      restrictToJobIds ? new Set(restrictToJobIds) : undefined,
    [restrictToJobIds],
  );

  const linkedJobIds = useMemo(() => {
    if (seedJobIds && seedJobIds.length > 0) {
      return collectWorkflowJobIds(seedJobIds, jobs, graph.edges, allowedJobIds);
    }
    const appJobIds = graph.appLinks[appId]?.jobIds ?? [];
    const appAllowed = new Set(appJobIds);
    return collectWorkflowJobIds(appJobIds, jobs, graph.edges, appAllowed);
  }, [seedJobIds, graph.appLinks, graph.edges, appId, jobs, allowedJobIds]);

  const workflowJobIds = linkedJobIds;

  const workflowJobs = useMemo(
    () => jobs.filter((j) => workflowJobIds.has(j.id)),
    [jobs, workflowJobIds],
  );

  const isStandalone = Boolean(seedJobIds);

  const edges = useMemo(
    () =>
      isStandalone
        ? buildStandaloneEdges(workflowJobs, graph)
        : buildWorkflowEdges(workflowJobs, graph, linkedJobIds, appId),
    [workflowJobs, graph, linkedJobIds, appId, isStandalone],
  );

  const positions = useMemo(
    () => computeWorkflowLayout(workflowJobs, edges, showAppNode ? appId : undefined),
    [workflowJobs, edges, appId, showAppNode],
  );

  const posMap = useMemo(() => {
    const map = new Map<string, NodePosition>();
    for (const pos of positions) map.set(pos.id, pos);
    return map;
  }, [positions]);

  const jobMap = useMemo(() => {
    const map = new Map<string, JobRecord>();
    for (const job of workflowJobs) map.set(job.id, job);
    return map;
  }, [workflowJobs]);

  const canvasSize = useMemo(
    () => getCanvasSize(positions, viewportWidth),
    [positions, viewportWidth],
  );

  const renderEdge = (edge: WorkflowEdge, index: number) => {
    const src = posMap.get(edge.from);
    const dst = posMap.get(edge.to);
    if (!src || !dst) return null;

    const srcW = src.kind === "app" ? APP_NODE_W : NODE_W;
    const srcH = src.kind === "app" ? APP_NODE_H : NODE_H;
    const dstW = dst.kind === "app" ? APP_NODE_W : NODE_W;
    const dstH = dst.kind === "app" ? APP_NODE_H : NODE_H;

    const x1 = src.x + srcW;
    const y1 = src.y + srcH / 2;
    const x2 = dst.x;
    const y2 = dst.y + dstH / 2;

    let strokeClass = "wf-edge--dep";
    if (edge.isDataLink) strokeClass = "wf-edge--data";
    else if (edge.isRuntimeCall) strokeClass = "wf-edge--runtime";
    else if (edge.onStatus === "failed") strokeClass = "wf-edge--failed";

    return (
      <path
        key={`${edge.from}-${edge.to}-${index}`}
        d={edgePath(x1, y1, x2, y2)}
        className={`wf-edge ${strokeClass}`}
        markerEnd={
          edge.isDataLink
            ? "url(#wf-arrow-data)"
            : edge.onStatus === "failed"
              ? "url(#wf-arrow-failed)"
              : "url(#wf-arrow-default)"
        }
      />
    );
  };

  if (workflowJobs.length === 0 && linkedJobIds.size === 0) {
    return (
      <div className="wf-empty">
        <div className="wf-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 6h6v6H4V6zm10 0h6v6h-6V6zM4 16h6v6H4v-6zm10 0h6v6h-6v-6z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </div>
        <p className="wf-empty-title">
          {isStandalone ? `No jobs in ${appName}` : `No workflow for ${appName}`}
        </p>
        <p className="wf-empty-desc">
          {isStandalone
            ? "Jobs appear here when their appIds is ['__standalone__'] (not linked to any mini-app)."
            : "Create jobs with appIds including this app's UUID, or link a data source to sync appIds automatically."}
        </p>
      </div>
    );
  }

  return (
    <div className="wf-canvas-wrap">
      <div className="wf-canvas-viewport" ref={viewportRef}>
        <div
          className="wf-canvas-content"
          style={{ width: "100%", minHeight: canvasSize.height, height: canvasSize.height }}
          onClick={onCanvasClick}
        >
        <svg
          className="wf-edges"
          width={canvasSize.width}
          height={canvasSize.height}
        >
          <defs>
            <marker
              id="wf-arrow-default"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" className="wf-arrow-default" />
            </marker>
            <marker
              id="wf-arrow-data"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" className="wf-arrow-data" />
            </marker>
            <marker
              id="wf-arrow-failed"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" className="wf-arrow-failed" />
            </marker>
          </defs>
          {edges.map(renderEdge)}
        </svg>

        <div className="wf-nodes">
          {positions
            .filter((p) => p.kind === "job")
            .map((pos) => {
              const job = jobMap.get(pos.id);
              if (!job) return null;
              return (
                <JobNodeCard
                  key={pos.id}
                  job={job}
                  position={pos}
                  isSelected={pos.id === selectedJobId}
                  trigger={triggerLabel(job)}
                  onSelect={() => onJobSelect(pos.id)}
                  onRun={() => onRunJob(pos.id)}
                  onStop={() => onStopJob(pos.id)}
                />
              );
            })}

          {positions
            .filter((p) => p.kind === "app")
            .map((pos) => (
              <AppNodeCard
                key={pos.id}
                appName={appName}
                appIcon={appIcon}
                position={pos}
                jobCount={linkedJobIds.size}
              />
            ))}
        </div>
        </div>
      </div>

      <div className="wf-legend">
        <span className="wf-legend-item">
          <span className="wf-legend-line wf-legend-line--dep" />
          Dependency
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-line wf-legend-line--data" />
          Data source
        </span>
        <span className="wf-legend-item">
          <span className="wf-legend-line wf-legend-line--runtime" />
          Runtime call
        </span>
      </div>
    </div>
  );
}
