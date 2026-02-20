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

  // Live logs stream in while job is running
  const liveLogs = useJobLiveLogsStore((s) =>
    data.status === "running" ? (s.logsByJobId.get(data.jobId) ?? []) : [],
  );

  const logs = data.status === "running" ? liveLogs : (data.logs ?? []);
  const logLines = logs.filter((line: string) => line.trim());

  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data.status === "running" && logLines.length > 0) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [data.status, logLines.length]);

  const statusIcon =
    {
      running: "🔄",
      waiting_permission: "🔑",
      completed: "✅",
      failed: "❌",
      pending: "⏸️",
    }[data.status] || "📋";

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
      data.waitingPermissionKeys.length > 0);
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
          <span className="job-status-card__title">{data.jobName}</span>
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

          {logLines.length > 0 ? (
            <div className="job-status-card__logs">
              <div className="job-status-card__logs-content">
                {logLines.slice(-24).map((log, i) => (
                  <div key={i} className="job-status-card__log-line">
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
              <button
                type="button"
                className="job-status-card__logs-link"
                onClick={() => {
                  // TODO: Open full logs
                }}
              >
                View logs →
              </button>
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
