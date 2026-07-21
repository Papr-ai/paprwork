/**
 * Job Status Card
 *
 * Compact inline card (like PlanCard) showing job execution status.
 * Collapsible; shows when job starts running, not just when finished.
 * Live logs stream in real time while job is running.
 */

import React, { useState, useRef, useEffect } from "react";
import { useJobLiveLogsStore } from "../../stores/jobLiveLogsStore";
import "./JobStatusCard.css";

export interface JobStatusData {
  type: "job_status";
  jobId: string;
  jobName: string;
  runId: string;
  status: string;
  startedAt: string;
  logs?: string[];
  waitingPermissionKeys?: string[];
}

interface Props {
  data: JobStatusData;
}

export function JobStatusCard({ data }: Props) {
  const [isExpanded, setIsExpanded] = useState(
    data.status === "running" || data.status === "waiting_permission",
  );

  // Get job name from store (updated via broadcast)
  const jobNameFromStore = useJobLiveLogsStore((s) => s.getJobName(data.jobId));
  const displayName = jobNameFromStore || data.jobName;

  // Live logs stream in while job is running
  const liveLogs = useJobLiveLogsStore((s) =>
    data.status === "running" ? (s.logsByJobId.get(data.jobId) ?? []) : [],
  );

  const logs = data.status === "running" ? liveLogs : (data.logs ?? []);
  const logLines = logs.filter((line: string) => line.trim());

  // Auto-scroll logs inside the card only (scrollIntoView would pull the whole chat)
  const logsContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data.status !== "running" || logLines.length === 0) return;
    const container = logsContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [data.status, logLines.length]);

  const statusIcon = {
    running: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    ),
    waiting_permission: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <rect
          x="5"
          y="11"
          width="14"
          height="10"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M12 15v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M7 11V7a5 5 0 0110 0v4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
    completed: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
          d="M20 6L9 17l-5-5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    failed: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M15 9l-6 6M9 9l6 6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
    pending: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M10 9h4v4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  }[data.status] || (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );

  const statusClass =
    {
      running: "job-status-running",
      waiting_permission: "job-status-waiting-permission",
      completed: "job-status-completed",
      failed: "job-status-failed",
    }[data.status] || "";

  const hasDetails =
    logLines.length > 0 ||
    (data.status === "waiting_permission" &&
      data.waitingPermissionKeys &&
      data.waitingPermissionKeys.length > 0) ||
    data.status === "running"; // Always expandable when running so user sees log area
  const displayStatus =
    data.status === "completed"
      ? "Completed"
      : data.status === "failed"
        ? "Failed"
        : data.status === "running"
          ? "Running"
          : data.status === "waiting_permission"
            ? "Waiting for approval"
            : data.status;

  return (
    <div className={`job-status-card job-status-card--compact ${statusClass}`}>
      <button
        type="button"
        className={`job-status-card__header${!hasDetails ? " job-status-card__header--no-expand" : ""}`}
        onClick={() => hasDetails && setIsExpanded((e) => !e)}
      >
        <div className="job-status-card__header-left">
          {hasDetails && (
            <svg
              className={`job-status-card__chevron${isExpanded ? " job-status-card__chevron--expanded" : ""}`}
              width="12"
              height="12"
              viewBox="0 0 12 12"
            >
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          )}
          <span className="job-status-card__icon">{statusIcon}</span>
          <span className="job-status-card__title">{displayName}</span>
        </div>
        <span
          className={`job-status-card__badge job-status-card__badge--${data.status}`}
        >
          {displayStatus}
        </span>
      </button>

      {isExpanded && (
        <div className="job-status-card__body">
          {data.status === "waiting_permission" &&
            data.waitingPermissionKeys &&
            data.waitingPermissionKeys.length > 0 && (
              <div className="job-status-card__waiting-keys">
                Waiting for approval: {data.waitingPermissionKeys.join(", ")}
              </div>
            )}

          {logLines.length > 0 || data.status === "running" ? (
            <div className="job-status-card__logs">
              <div
                ref={logsContainerRef}
                className="job-status-card__logs-content"
              >
                {logLines.length > 0 ? (
                  <>
                    {(logLines ?? []).slice(-24).map((log, i) => (
                      <div key={i} className="job-status-card__log-line">
                        {log}
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="job-status-card__logs-placeholder">
                    <span className="job-status-card__logs-placeholder-dot" />
                    Waiting for output…
                  </div>
                )}
              </div>
              {logLines.length > 0 && (
                <div
                  role="button"
                  tabIndex={0}
                  className="job-status-card__logs-link"
                  onClick={(e) => {
                    e.stopPropagation(); // Prevent header collapse toggle
                    // TODO: Open full logs
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      // TODO: Open full logs
                    }
                  }}
                >
                  View logs →
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Parse job status from tool result
 */
export function parseJobStatusFromToolResult(
  toolName: string,
  result: string | unknown,
): JobStatusData | null {
  if (toolName !== "run_job") return null;

  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const data = parsed.data || parsed;

    if (data.type === "job_status") {
      return {
        type: "job_status",
        jobId: data.jobId,
        jobName: data.jobName || data.jobId,
        runId: data.runId || "latest",
        status: data.status || "unknown",
        startedAt: data.startedAt || new Date().toISOString(),
        logs: data.logs || [],
        waitingPermissionKeys: data.waitingPermissionKeys,
      };
    }
  } catch (e) {
    // Not a job status result
  }

  return null;
}
