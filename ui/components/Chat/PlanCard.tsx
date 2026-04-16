/**
 * PlanCard - Renders a plan with step progress from create_plan/update_plan tool results
 */

import { useState, useMemo } from "react";
import "./PlanCard.css";

interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

interface PlanData {
  planId: string;
  title: string;
  steps: PlanStep[];
  createdAt?: string;
  updatedAt?: string;
  deleted?: boolean;
}

interface PlanCardProps {
  data: PlanData;
}

const STATUS_ICONS: Record<PlanStep["status"], string> = {
  pending: "○",
  in_progress: "◉",
  completed: "✓",
  skipped: "−",
};

const STATUS_LABELS: Record<PlanStep["status"], string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  skipped: "Skipped",
};

export function PlanCard({ data }: PlanCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(data.deleted ?? false);

  const { completed, total, percentage } = useMemo(() => {
    const t = data.steps.length;
    const c = data.steps.filter(
      (s) => s.status === "completed" || s.status === "skipped",
    ).length;

    return {
      completed: c,
      total: t,
      percentage: t > 0 ? Math.round((c / t) * 100) : 0,
    };
  }, [data.steps]);

  if (data.deleted) {
    return (
      <div className="plan-card plan-card--deleted">
        <div className="plan-card__header plan-card__header--deleted">
          <div className="plan-card__header-left">
            <span className="plan-card__deleted-icon">✗</span>
            <span className="plan-card__title">{data.title}</span>
          </div>
          <span className="plan-card__deleted-label">Deleted</span>
        </div>
      </div>
    );
  }

  return (
    <div className="plan-card">
      <button
        className="plan-card__header"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="plan-card__header-left">
          <svg
            className={`plan-card__chevron${isCollapsed ? "" : " plan-card__chevron--expanded"}`}
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
          <span className="plan-card__title">{data.title}</span>
        </div>
        <div className="plan-card__progress-info">
          <span className="plan-card__progress-text">
            {completed}/{total}
          </span>
          <div className="plan-card__progress-bar">
            <div
              className="plan-card__progress-fill"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </button>

      {!isCollapsed && (
        <div className="plan-card__steps">
          {data.steps.map((step) => (
            <div
              key={step.id}
              className={`plan-card__step plan-card__step--${step.status}`}
            >
              <span className="plan-card__step-icon">
                {STATUS_ICONS[step.status]}
              </span>
              <span className="plan-card__step-desc">{step.description}</span>
              <span className="plan-card__step-status">
                {STATUS_LABELS[step.status]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Try to extract PlanData from a tool result string.
 * Returns null if it doesn't look like a plan result.
 */
export function parsePlanFromToolResult(
  toolName: string,
  result: string | undefined,
): PlanData | null {
  if (
    toolName !== "create_plan" &&
    toolName !== "update_plan" &&
    toolName !== "delete_plan"
  )
    return null;
  if (!result) return null;

  try {
    const parsed = JSON.parse(result) as {
      data?: PlanData & { deleted?: boolean };
      success?: boolean;
    };

    if (parsed?.data?.planId && parsed?.data?.steps) {
      if (toolName === "delete_plan" || parsed.data.deleted) {
        parsed.data.deleted = true;
      }
      return parsed.data;
    }

    const direct = parsed as unknown as PlanData;
    if (direct?.planId && direct?.steps) {
      if (toolName === "delete_plan") {
        direct.deleted = true;
      }
      return direct;
    }
  } catch {
    try {
      const doubleString = JSON.parse(result);
      if (typeof doubleString === "string") {
        return parsePlanFromToolResult(toolName, doubleString);
      }
    } catch {
      /* not double-stringified */
    }
  }

  return null;
}
