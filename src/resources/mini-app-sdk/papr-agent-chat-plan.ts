/**
 * Plan card parsing + HTML rendering for embedded app-agent chat SDK.
 */

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

export interface PlanData {
  planId: string;
  title: string;
  steps: PlanStep[];
  deleted?: boolean;
}

const STATUS_ICONS: Record<PlanStep["status"], string> = {
  pending: "○",
  in_progress: "◉",
  completed: "✓",
  skipped: "−",
};

export function parsePlanFromToolResult(
  toolName: string,
  result: unknown,
): PlanData | null {
  if (
    toolName !== "create_plan" &&
    toolName !== "update_plan" &&
    toolName !== "delete_plan"
  ) {
    return null;
  }
  if (result === undefined || result === null) {
    return null;
  }

  const resultStr =
    typeof result === "string" ? result : JSON.stringify(result);

  try {
    const parsed = JSON.parse(resultStr) as {
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
    /* not JSON */
  }

  return null;
}

export function renderPlanCardHtml(plan: PlanData, collapsed: boolean): string {
  if (plan.deleted) {
    return `
      <div class="papr-agent-chat-plan papr-agent-chat-plan--deleted">
        <div class="papr-agent-chat-plan__header">
          <span class="papr-agent-chat-plan__deleted-icon">✗</span>
          <span class="papr-agent-chat-plan__title">${escapeHtml(plan.title)}</span>
          <span class="papr-agent-chat-plan__deleted-label">Deleted</span>
        </div>
      </div>`;
  }

  const completed = plan.steps.filter(
    (s) => s.status === "completed" || s.status === "skipped",
  ).length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const stepsHtml = plan.steps
    .map(
      (step) => `
      <div class="papr-agent-chat-plan__step papr-agent-chat-plan__step--${step.status}">
        <span class="papr-agent-chat-plan__step-icon">${STATUS_ICONS[step.status]}</span>
        <span class="papr-agent-chat-plan__step-desc">${escapeHtml(step.description)}</span>
      </div>`,
    )
    .join("");

  return `
    <div class="papr-agent-chat-plan" data-plan-id="${escapeHtml(plan.planId)}">
      <button type="button" class="papr-agent-chat-plan__header" aria-expanded="${!collapsed}">
        <span class="papr-agent-chat-plan__chevron${collapsed ? " papr-agent-chat-plan__chevron--collapsed" : ""}">▼</span>
        <span class="papr-agent-chat-plan__title">${escapeHtml(plan.title)}</span>
        <span class="papr-agent-chat-plan__progress">${completed}/${total}</span>
        <span class="papr-agent-chat-plan__bar"><span style="width:${pct}%"></span></span>
      </button>
      <div class="papr-agent-chat-plan__steps${collapsed ? " papr-agent-chat-plan__steps--collapsed" : ""}">
        ${stepsHtml}
      </div>
    </div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
