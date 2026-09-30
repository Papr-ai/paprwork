/**
 * MiniAppJobsView — per-app job workflow (same canvas as Jobs tab).
 */

import { useCallback, useMemo, useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobRecord } from "../../hooks/useJobs";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { openJobInJobsTab } from "../../stores/jobNavigationStore";
import { jobTriggerLabel } from "../../utils/jobTriggerLabel";
import { AppWorkflow } from "../Jobs/AppWorkflow";
import "../Jobs/AppWorkflow.css";
import "../Jobs/JobsView.css";
import "./MiniAppJobsView.css";

interface MiniAppJobsViewProps {
  appId: string;
  appTitle: string;
}

function formatRelativeTime(isoString?: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 0) return "";
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

export function MiniAppJobsView({ appId, appTitle }: MiniAppJobsViewProps) {
  const { jobs, graph, graphLoaded, loading, error, runJob, stopJob, loadLogs, logsByJobId } =
    useJobs();
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const appIcon = useMemo(
    () => artifacts.find((entry) => entry.id === appId && entry.type === "app")?.icon,
    [artifacts, appId],
  );

  const linkedJobIds = useMemo(
    () => graph?.appLinks[appId]?.jobIds ?? [],
    [graph, appId],
  );

  const selectedJob = useMemo(
    () => (selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null),
    [jobs, selectedJobId],
  );

  const handleJobSelect = useCallback(
    (jobId: string) => {
      setSelectedJobId(jobId);
      void loadLogs(jobId);
    },
    [loadLogs],
  );

  const triggerLabel = useCallback(
    (job: JobRecord) => jobTriggerLabel(job, jobs),
    [jobs],
  );

  if (loading && !graphLoaded) {
    return (
      <div className="mini-app-jobs">
        <p className="mini-app-jobs__status">Loading jobs…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mini-app-jobs">
        <p className="mini-app-jobs__error">{error}</p>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="mini-app-jobs">
        <p className="mini-app-jobs__status">Job graph unavailable.</p>
      </div>
    );
  }

  return (
    <div
      className={`mini-app-jobs ${selectedJob ? "mini-app-jobs--panel-open" : ""}`}
    >
      <div className="mini-app-jobs__workflow">
        <AppWorkflow
          appId={appId}
          appName={appTitle}
          appIcon={appIcon}
          jobs={jobs}
          graph={graph}
          selectedJobId={selectedJobId}
          onJobSelect={handleJobSelect}
          onCanvasClick={() => setSelectedJobId(null)}
          onRunJob={(jobId) => void runJob(jobId)}
          onStopJob={(jobId) => void stopJob(jobId)}
          triggerLabel={triggerLabel}
          restrictToJobIds={linkedJobIds}
          showAppNode
        />
      </div>

      {selectedJob ? (
        <aside className="mini-app-jobs__detail jv2-wf-detail-sidebar">
          <div className="jv2-wf-panel">
            <div className="jv2-wf-panel-header">
              <h3 className="jv2-wf-panel-title">{selectedJob.name}</h3>
              <span className="jv2-type">{selectedJob.type}</span>
              <button
                type="button"
                className="jv2-wf-panel-close"
                title="Close"
                onClick={() => setSelectedJobId(null)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M18 6L6 18M6 6l12 12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            <div className="jv2-wf-panel-actions">
              {selectedJob.status === "running" ||
              selectedJob.status === "waiting_permission" ? (
                <button
                  type="button"
                  className="jv2-wf-action-btn"
                  onClick={() => void stopJob(selectedJob.id)}
                >
                  Stop
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="jv2-wf-action-btn jv2-wf-action-btn--primary"
                    onClick={() => void runJob(selectedJob.id)}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="jv2-wf-action-btn"
                    onClick={() => openJobInJobsTab(selectedJob.id)}
                  >
                    Open in Jobs
                  </button>
                </>
              )}
            </div>

            <div className="jv2-detail-grid">
              <div className="jv2-detail-cell">
                <span className="jv2-detail-label">Status</span>
                <span className="jv2-detail-value">{selectedJob.status}</span>
              </div>
              {triggerLabel(selectedJob) ? (
                <div className="jv2-detail-cell jv2-detail-cell--full">
                  <span className="jv2-detail-label">Trigger</span>
                  <span className="jv2-detail-value">{triggerLabel(selectedJob)}</span>
                </div>
              ) : null}
              <div className="jv2-detail-cell">
                <span className="jv2-detail-label">Last run</span>
                <span className="jv2-detail-value">
                  {formatRelativeTime(selectedJob.lastRunAt) || "Never"}
                </span>
              </div>
              {selectedJob.error ? (
                <div className="jv2-detail-cell jv2-detail-cell--full">
                  <span className="jv2-detail-label">Error</span>
                  <span className="jv2-detail-value jv2-detail-value--error">
                    {selectedJob.error}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="jv2-logs-section">
              <div className="jv2-logs-header">
                <span className="jv2-detail-label">Logs</span>
                <button
                  type="button"
                  className="jv2-btn-text"
                  onClick={() => void loadLogs(selectedJob.id)}
                >
                  Refresh
                </button>
              </div>
              <pre className="jv2-logs">
                {logsByJobId[selectedJob.id]?.trim() || "No logs yet."}
              </pre>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
