/**
 * DelegationCard - Compact card for delegate_task tool result
 *
 * Matches PlanCard style: single-line header, collapsible body.
 * Shows live logs from sub-agent execution (thinking, tool calls, etc.)
 */

import React, { useState, useRef, useEffect } from "react";
import { Markdown } from "../common/Markdown";
import { useJobLiveLogsStore } from "../../stores/jobLiveLogsStore";
import "./DelegationCard.css";

export interface DelegationData {
  id: string;
  agentId: string;
  agentName?: string;
  task: string;
  context?: string;
  status: "pending" | "running" | "completed" | "failed";
  resultText?: string;
  error?: string;
  /** When set, show MiniChatCard (inline chat with Join). May come from args or auto-injected by tool. */
  reportChatId?: string;
}

interface Props {
  data: DelegationData;
}

/** SVG status icons matching sidebar style (stroke, no fill) */
function StatusIcon({ status }: { status: DelegationData["status"] }) {
  const className = `delegation-card__icon delegation-card__icon--${status}`;
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (status) {
    case "pending":
      return (
        <svg className={className} {...common}>
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
    case "running":
      return (
        <svg className={className} {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
    case "completed":
      return (
        <svg className={className} {...common}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      );
    case "failed":
      return (
        <svg className={className} {...common}>
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      );
  }
}

const STATUS_LABELS: Record<DelegationData["status"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Done",
  failed: "Failed",
};

export function DelegationCard({ data }: Props) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const agentLabel = data.agentName || data.agentId;
  const title = `${agentLabel}: ${data.task.length > 40 ? `${data.task.slice(0, 40)}…` : data.task}`;

  // Live logs for running delegations (sub-agent execution logs)
  const liveLogs = useJobLiveLogsStore((s) =>
    data.status === "running" ? (s.logsByJobId.get(data.id) ?? []) : [],
  );
  const logLines = liveLogs.filter((line: string) => line.trim());

  // Auto-scroll to latest log
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data.status === "running" && logLines.length > 0) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [data.status, logLines.length]);

  const hasDetails =
    !!data.resultText || !!data.error || !!data.context || logLines.length > 0;

  return (
    <div className="delegation-card" data-testid="delegation-card">
      <button
        type="button"
        className="delegation-card__header"
        onClick={() => hasDetails && setIsCollapsed((c) => !c)}
      >
        <div className="delegation-card__header-left">
          <svg
            className={`delegation-card__chevron${isCollapsed ? "" : " delegation-card__chevron--expanded"}`}
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
          <StatusIcon status={data.status} />
          <span className="delegation-card__title" title={data.task}>
            {title}
          </span>
        </div>
        <span
          className={`delegation-card__badge delegation-card__badge--${data.status}`}
        >
          {STATUS_LABELS[data.status]}
        </span>
      </button>

      {!isCollapsed && hasDetails && (
        <div className="delegation-card__body">
          {data.context && (
            <div className="delegation-card__context">{data.context}</div>
          )}

          {/* Live logs while sub-agent is running */}
          {logLines.length > 0 && data.status === "running" && (
            <div className="delegation-card__logs">
              <div className="delegation-card__logs-header">
                Sub-agent Activity
              </div>
              <div className="delegation-card__logs-content">
                {logLines.slice(-24).map((log, i) => (
                  <div key={i} className="delegation-card__log-line">
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {data.error && (
            <div className="delegation-card__error">{data.error}</div>
          )}
          {data.resultText && !data.error && (
            <div className="delegation-card__result">
              <Markdown>{data.resultText}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Parse delegation run from delegate_task tool result.
 * Handles multiple shapes: { success, data }, { data }, or run object directly.
 */
export function parseDelegationFromToolResult(
  toolName: string,
  result: string | unknown,
): DelegationData | null {
  if (toolName !== "delegate_task") return null;
  if (result === undefined || result === null) return null;

  try {
    const parsed =
      typeof result === "string"
        ? (JSON.parse(result) as Record<string, unknown>)
        : (result as Record<string, unknown>);

    // Try multiple shapes: { success, data }, { data }, or run object directly
    const data =
      (parsed?.data as Record<string, unknown> | undefined) ??
      (parsed as Record<string, unknown>);

    if (!data || typeof data !== "object") return null;

    const id =
      (data.id as string) ??
      (data.jobId as string) ??
      (data.delegationId as string);
    const task =
      (data.task as string) ??
      (data.delegationTask as string) ??
      (data.command as string);

    if (!id || !task) {
      return null;
    }

    return {
      id: String(id),
      agentId: (data.agentId ?? data.subAgentId ?? "unknown") as string,
      agentName: data.agentName as string | undefined,
      task: String(task),
      context: data.context as string | undefined,
      status:
        data.status === "pending" ||
        data.status === "running" ||
        data.status === "completed" ||
        data.status === "failed"
          ? (data.status as DelegationData["status"])
          : "completed",
      resultText: data.resultText as string | undefined,
      error: data.error as string | undefined,
      reportChatId: data.reportChatId as string | undefined,
    };
  } catch {
    return null;
  }
}
