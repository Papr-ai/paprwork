/**
 * AppJobsPanel — the Jobs tab of the app's side panel.
 *
 * Two sections (Scheduled / One off), each a small canvas of
 * the live workflow cards and curved edges. Nothing opens until a card is
 * clicked; a failed job is already red. Clicking a card opens its details in a
 * modal: the latest run's log, Run now, and "Ask Pen to fix" when it failed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useJobs, type JobRecord } from "../../hooks/useJobs";
import { openJobInJobsTab } from "../../stores/jobNavigationStore";
import { jobTriggerLabel } from "../../utils/jobTriggerLabel";
import { JobTypeIcon } from "../../utils/jobTypeIcon";
import { relativeWhen } from "../../utils/appsHome";
import { openCloudSyncAgentChat } from "../../utils/openCloudSyncAgentChat";
import { AgentGlyph } from "../Agent/AgentGlyph";
import {
  NARROW_CARD,
  WIDE_CARD,
  groupJobSections,
  layoutSection,
  type CardDims,
  type JobSection,
  type JobSectionId,
} from "../Jobs/jobSections";
import { edgePath, jobTypeColor } from "../Jobs/workflowUtils";
import "../Jobs/AppWorkflow.css";
import "./AppJobsPanel.css";

const TITLE: Record<JobSectionId, string> = {
  scheduled: "Scheduled",
  oneOff: "One off",
};

const AGENT_TYPES = new Set(["agent", "subagent"]);

function SectionIcon({ id }: { id: JobSectionId }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (id === "scheduled") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5V8l2.5 1.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.8 5.6 10.2 8l-3.4 2.4z" fill="currentColor" />
    </svg>
  );
}

function jobFailed(job: JobRecord): boolean {
  return job.status === "failed";
}

function triggerText(job: JobRecord, all: JobRecord[]): string {
  return jobTriggerLabel(job, all);
}

function Card({
  job,
  x,
  y,
  dims,
  compact,
  trigger,
  selected,
  onSelect,
  onRun,
  onStop,
}: {
  job: JobRecord;
  x: number;
  y: number;
  dims: CardDims;
  compact: boolean;
  trigger: string;
  selected: boolean;
  onSelect: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const failed = jobFailed(job);
  const running = job.status === "running" || job.status === "waiting_permission";
  const isAgent = AGENT_TYPES.has(job.type);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-job-id={job.id}
      className={[
        "wf-node",
        "wf-node--job",
        "ajp-card",
        failed ? "ajp-card--failed" : "",
        running ? "wf-node--running" : "",
        selected ? "wf-node--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={`${job.name} — ${trigger}`}
      style={{
        left: x,
        top: y,
        width: dims.w,
        height: dims.h,
        ["--wf-type-color" as string]: failed ? "#ef4444" : jobTypeColor(job.type),
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="wf-node-port wf-node-port--in" />
      <div className="wf-node-body">
        <div className="wf-node-header">
          <span
            className={`wf-node-type-icon ${failed ? "wf-status--failed" : ""} ${isAgent ? "ajp-agent-icon" : ""}`}
          >
            {isAgent ? <AgentGlyph size={16} /> : <JobTypeIcon type={job.type} size={14} />}
          </span>
          <span className="wf-node-title">{job.name}</span>
        </div>
        <div className="wf-node-meta">
          {compact ? null : <span className="wf-node-type">{job.type}</span>}
          {failed ? (
            <span className="ajp-fail">Failed {relativeWhen(job.completedAt ?? job.lastRunAt)}</span>
          ) : (
            <span className="wf-node-trigger ajp-trigger">{trigger}</span>
          )}
        </div>
      </div>
      {compact ? null : (
        <button
          type="button"
          className="wf-node-action"
          title={running ? "Stop" : "Run"}
          aria-label={running ? `Stop ${job.name}` : `Run ${job.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (running) onStop();
            else onRun();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
            {running ? (
              <rect x="6" y="6" width="12" height="12" fill="currentColor" />
            ) : (
              <path d="M8 5v14l11-7-11-7z" fill="currentColor" />
            )}
          </svg>
        </button>
      )}
      <div className="wf-node-port wf-node-port--out" />
    </div>
  );
}

function SectionCanvas({
  section,
  dims,
  compact,
  allJobs,
  selectedId,
  onSelect,
  onRun,
  onStop,
}: {
  section: JobSection;
  dims: CardDims;
  compact: boolean;
  allJobs: JobRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const layout = useMemo(
    () => layoutSection(section, dims, compact ? 3 : 4),
    [section, dims, compact],
  );
  const markerId = `ajp-${section.id}`;
  return (
    <div className="ajp-canvas">
      <div className="wf-canvas-content" style={{ width: layout.width, height: layout.height }}>
        <svg className="wf-edges" width={layout.width} height={layout.height} aria-hidden>
          <defs>
            {(["default", "failed"] as const).map((k) => (
              <marker
                key={k}
                id={`${markerId}-${k}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" className={`wf-arrow-${k}`} />
              </marker>
            ))}
          </defs>
          {section.edges.map((e) => {
            const s = layout.positions.get(e.from);
            const t = layout.positions.get(e.to);
            if (!s || !t) return null;
            return (
              <path
                key={`${e.from}-${e.to}`}
                className={`wf-edge wf-edge--${e.kind}`}
                markerEnd={`url(#${markerId}-${e.kind === "failed" ? "failed" : "default"})`}
                d={edgePath(s.x + dims.w, s.y + dims.h / 2, t.x, t.y + dims.h / 2)}
              />
            );
          })}
        </svg>
        <div className="wf-nodes">
          {section.jobs.map((job) => {
            const pos = layout.positions.get(job.id);
            if (!pos) return null;
            return (
              <Card
                key={job.id}
                job={job}
                x={pos.x}
                y={pos.y}
                dims={dims}
                compact={compact}
                trigger={triggerText(job, allJobs)}
                selected={selectedId === job.id}
                onSelect={() => onSelect(job.id)}
                onRun={() => onRun(job.id)}
                onStop={() => onStop(job.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Only the latest run: logs append every attempt, oldest first. */
export function latestRunLog(logs: string): string {
  const marks = [...logs.matchAll(/^.*\[attempt \d+\/\d+\] Waiting for execution capacity.*$/gm)];
  const from = marks.length ? (marks[marks.length - 1].index ?? 0) : 0;
  return logs.slice(from).trim();
}

function JobDetail({
  job,
  trigger,
  logs,
  onClose,
  onRun,
}: {
  job: JobRecord;
  trigger: string;
  logs?: string;
  onClose: () => void;
  onRun: () => void;
}) {
  const failed = jobFailed(job);
  const when = relativeWhen(job.completedAt ?? job.lastRunAt);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const askPen = (): void => {
    onClose();
    openCloudSyncAgentChat(
      [
        `The job "${job.name}" (id ${job.id}) failed${when ? ` ${when}` : ""}.`,
        job.error ? `Error:\n${job.error}` : "",
        "Read its logs, find the cause, fix it, and run it again to confirm.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      { send: true, title: `Fix ${job.name}` },
    );
  };
  const log = latestRunLog(logs ?? "");
  return createPortal(
    <div className="ajp-modal" onClick={onClose}>
      <div
        className={`ajp-detail${failed ? " ajp-detail--failed" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={job.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ajp-detail__head">
          <b>{job.name}</b>
          <span className={`ajp-detail__status${failed ? " is-bad" : ""}`}>
            {failed ? `Failed ${when}` : job.lastRunAt ? `Last run ${when}` : "Not run yet"}
          </span>
          <button type="button" className="ajp-detail__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="ajp-detail__kv">
          <span>Starts</span>
          <b>{trigger}</b>
        </div>
        {failed && job.error ? <p className="ajp-detail__error">{job.error.trim()}</p> : null}
        <pre className={`ajp-detail__log${failed ? " is-bad" : ""}`}>
          {log || (job.lastRunAt ? "Loading log…" : "No runs yet.")}
        </pre>
        <div className="ajp-detail__acts">
          {failed ? (
            <button type="button" className="ajp-btn ajp-btn--primary" onClick={askPen}>
              Ask Pen to fix
            </button>
          ) : null}
          <button type="button" className="ajp-btn" onClick={onRun}>
            Run now
          </button>
          <button
            type="button"
            className="ajp-btn ajp-btn--quiet"
            onClick={() => {
              onClose();
              openJobInJobsTab(job.id);
            }}
          >
            All runs
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface AppJobsPanelProps {
  appId: string;
  /** Beside the app: narrower cards (name + trigger), no type label or run button. */
  compact: boolean;
  /** Open this job's details on mount (e.g. from the "job failing" chip). */
  focusJobId?: string | null;
}

export function AppJobsPanel({ appId, compact, focusJobId }: AppJobsPanelProps) {
  const { jobs, graph, graphLoaded, loading, error, runJob, stopJob, loadLogs, logsByJobId } =
    useJobs();
  const [selectedId, setSelectedId] = useState<string | null>(focusJobId ?? null);

  useEffect(() => {
    if (!focusJobId) return;
    setSelectedId(focusJobId);
    void loadLogs(focusJobId);
    // Only re-run for a new focus, not when loadLogs' identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusJobId]);

  const appJobs = useMemo(() => {
    const ids = new Set(graph?.appLinks[appId]?.jobIds ?? []);
    return jobs.filter((j) => ids.has(j.id) || j.appIds?.includes(appId));
  }, [jobs, graph, appId]);

  const sections = useMemo(
    () => groupJobSections(appJobs, graph?.edges ?? []),
    [appJobs, graph],
  );

  const select = useCallback(
    (id: string) => {
      setSelectedId((cur) => (cur === id ? null : id));
      void loadLogs(id);
    },
    [loadLogs],
  );

  const closeDetail = useCallback(() => setSelectedId(null), []);
  const selected = selectedId ? appJobs.find((j) => j.id === selectedId) : undefined;
  const dims = compact ? NARROW_CARD : WIDE_CARD;

  if (loading && !graphLoaded) {
    return <p className="ajp-status">Loading jobs…</p>;
  }
  if (error) {
    return <p className="ajp-status ajp-status--error">{error}</p>;
  }
  if (appJobs.length === 0) {
    return (
      <div className="ajp-empty">
        <p className="ajp-empty__title">No jobs yet</p>
        <p className="ajp-empty__desc">Ask Pen to add one, like a daily sync or a button that runs a script.</p>
      </div>
    );
  }

  return (
    <div className={`ajp${compact ? " ajp--compact" : ""}`} onClick={() => setSelectedId(null)}>
      {sections.map((section) => (
        <section key={section.id} className="ajp-section" aria-label={TITLE[section.id]}>
          <h4 className="ajp-section__title">
            <SectionIcon id={section.id} />
            {TITLE[section.id]}
          </h4>
          <SectionCanvas
            section={section}
            dims={dims}
            compact={compact}
            allJobs={jobs}
            selectedId={selectedId}
            onSelect={select}
            onRun={(id) => void runJob(id)}
            onStop={(id) => void stopJob(id)}
          />
        </section>
      ))}
      {selected ? (
        <JobDetail
          job={selected}
          trigger={triggerText(selected, jobs)}
          logs={logsByJobId[selected.id]}
          onClose={closeDetail}
          onRun={() => void runJob(selected.id).then(() => loadLogs(selected.id))}
        />
      ) : null}
    </div>
  );
}
