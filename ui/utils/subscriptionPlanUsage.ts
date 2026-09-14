export type BillingMode = "metered" | "subscription";

/** Input from IPC / Settings usage fetch (see claudeOAuthUsage.ts). */
export type ClaudeUsageLimitsSnapshotInput = {
  fetchedAt: string;
  rows: Array<{
    id: string;
    label: string;
    percent: number;
    isActive: boolean;
  }>;
  extraUsageEnabled?: boolean | null;
  subscriptionType?: string | null;
};

export type PlanUsageScopedWeekly = {
  label: string;
  percent: number;
  isActive: boolean;
};

/** Compact plan snapshot for the context panel (from Settings usage API). */
export type PlanUsageSummary = {
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionIsActive: boolean;
  weeklyIsActive: boolean;
  scopedWeekly: PlanUsageScopedWeekly[];
  /** Highest-utilization active limit, when the API marks one. */
  activePercent: number | null;
  activeLabel: string | null;
  subscriptionType: string | null;
  /** From usage API `extra_usage.is_enabled` — pay-as-you-go after included limits. */
  extraUsageEnabled: boolean | null;
  fetchedAt: string;
};

export type PlanUsageHeroLine = {
  key: string;
  label: string;
  percent: number;
  isActive: boolean;
};

export type PlanUsageHeroLineOptions = {
  /** Scoped weekly rows (e.g. Fable) only matter when that model is selected. */
  includeFableWeekly: boolean;
};

/** Matches claude.ai Settings → Usage / Claude Code `/usage` wording. */
export const CLAUDE_PLAN_USAGE_BRAND = "Claude";
export const CLAUDE_PLAN_USAGE_TITLE = "Plan usage";

/** Default subline when plan % is not loaded yet. */
export const CLAUDE_PLAN_USAGE_SUBLINE = "Included · shared across Claude";

/** @deprecated Use CLAUDE_PLAN_USAGE_* — kept for imports. */
export const CLAUDE_SUBSCRIPTION_SUBLINE = CLAUDE_PLAN_USAGE_SUBLINE;

/** True when the chat is on a Fable model (scoped weekly limit applies). */
export function chatModelIsFable(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes("fable");
}

export function summarizeClaudePlanUsage(
  data: ClaudeUsageLimitsSnapshotInput,
): PlanUsageSummary {
  let sessionPercent: number | null = null;
  let weeklyPercent: number | null = null;
  let sessionIsActive = false;
  let weeklyIsActive = false;
  const scopedWeekly: PlanUsageScopedWeekly[] = [];

  for (const row of data.rows) {
    if (
      row.id.startsWith("session") ||
      row.label === "Current session" ||
      row.id === "session"
    ) {
      sessionPercent = row.percent;
      sessionIsActive = row.isActive;
    } else if (
      row.id.startsWith("weekly_all") ||
      row.label === "All models" ||
      row.id === "weekly_all"
    ) {
      weeklyPercent = row.percent;
      weeklyIsActive = row.isActive;
    } else if (row.id.startsWith("weekly_scoped:")) {
      scopedWeekly.push({
        label: row.label,
        percent: row.percent,
        isActive: row.isActive,
      });
    }
  }

  const active = data.rows.find((r) => r.isActive);
  return {
    sessionPercent,
    weeklyPercent,
    sessionIsActive,
    weeklyIsActive,
    scopedWeekly,
    activePercent: active?.percent ?? null,
    activeLabel: active?.label ?? null,
    subscriptionType: data.subscriptionType ?? null,
    extraUsageEnabled: data.extraUsageEnabled ?? null,
    fetchedAt: data.fetchedAt,
  };
}

function planAtIncludedLimit(plan: PlanUsageSummary): boolean {
  const percents: number[] = [];
  if (plan.sessionPercent !== null) percents.push(plan.sessionPercent);
  if (plan.weeklyPercent !== null) percents.push(plan.weeklyPercent);
  for (const scoped of plan.scopedWeekly) {
    percents.push(scoped.percent);
  }
  return percents.some((p) => p >= 100);
}

/**
 * Subline under plan usage — reflects included pool vs extra (overage) billing.
 * Plan % still comes from the same usage API when extra usage is on; we do not show $ here.
 */
export function formatClaudeSubscriptionSubline(
  plan: PlanUsageSummary | null,
): string {
  if (!plan) {
    return CLAUDE_PLAN_USAGE_SUBLINE;
  }

  const atLimit = planAtIncludedLimit(plan);

  if (atLimit && plan.extraUsageEnabled === true) {
    return "Extra usage · billed on top of your plan";
  }
  if (atLimit && plan.extraUsageEnabled === false) {
    return "At included limit · extra usage is off";
  }
  if (atLimit) {
    return "At included limit";
  }

  if (plan.subscriptionType) {
    const tier = plan.subscriptionType.replace(/_/g, " ");
    return `${tier} · ${CLAUDE_PLAN_USAGE_SUBLINE}`;
  }
  return CLAUDE_PLAN_USAGE_SUBLINE;
}

/** Labeled rows for the context panel — never a bare number without a window name. */
export function getPlanUsageHeroLines(
  plan: PlanUsageSummary,
  options?: PlanUsageHeroLineOptions,
): PlanUsageHeroLine[] {
  const includeFableWeekly = options?.includeFableWeekly ?? false;
  const lines: PlanUsageHeroLine[] = [];
  if (plan.sessionPercent !== null) {
    lines.push({
      key: "session",
      label: "Session (5h)",
      percent: plan.sessionPercent,
      isActive: plan.sessionIsActive,
    });
  }
  if (plan.weeklyPercent !== null) {
    lines.push({
      key: "weekly_all",
      label: "Weekly (all models)",
      percent: plan.weeklyPercent,
      isActive: plan.weeklyIsActive,
    });
  }
  if (includeFableWeekly) {
    for (const scoped of plan.scopedWeekly) {
      if (scoped.label.toLowerCase() !== "fable") continue;
      lines.push({
        key: `weekly_scoped:${scoped.label}`,
        label: "Weekly (Fable)",
        percent: scoped.percent,
        isActive: scoped.isActive,
      });
    }
  }
  return lines;
}

/** Detail copy for the (i) tooltip beside plan usage in the context panel. */
export function getPlanUsageTooltipLines(
  plan: PlanUsageSummary | null,
  options?: PlanUsageHeroLineOptions,
): string[] {
  const lines: string[] = [];
  if (plan) {
    for (const row of getPlanUsageHeroLines(plan, options)) {
      lines.push(`${row.percent}% · ${row.label}`);
    }
    lines.push(formatClaudeSubscriptionSubline(plan));
  } else {
    lines.push(CLAUDE_PLAN_USAGE_SUBLINE);
  }
  lines.push("Same as claude.ai Settings → Usage (whole account).");
  return lines;
}

export function formatChatTotalsLine(
  billingMode: BillingMode,
  turns: number,
  cost: number,
): string {
  if (billingMode === "subscription") {
    return `${turns} turn${turns === 1 ? "" : "s"} · included usage`;
  }
  return `${turns} turn${turns === 1 ? "" : "s"} · ${formatMeteredCost(cost)}`;
}

function formatMeteredCost(cost: number): string {
  if (!cost) return "$0 this chat";
  if (cost < 0.01) return `$${cost.toFixed(4)} this chat`;
  if (cost < 1) return `$${cost.toFixed(3)} this chat`;
  return `$${cost.toFixed(2)} this chat`;
}

export function planUsageRingHint(
  plan: PlanUsageSummary | null,
  modelId: string | null | undefined,
): string | null {
  if (!plan) return null;
  const lines = getPlanUsageHeroLines(plan, {
    includeFableWeekly: chatModelIsFable(modelId),
  });
  if (lines.length === 0) return null;
  return `Plan: ${lines.map((l) => `${l.percent}% ${l.label}`).join(" · ")}`;
}
