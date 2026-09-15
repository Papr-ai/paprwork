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

/**
 * What the dollar figure on a turn actually means.
 *
 * A subscription login does not make a turn free — it makes it free *until the
 * included allowance runs out*, after which the provider bills per token on top
 * of the plan. So the basis is decided by the plan's own reported utilization,
 * never by which credential was used to authenticate.
 */
export type CostBasis =
  | "metered"
  /** Inside the included allowance: the figure is list price, not a charge. */
  | "plan_included"
  /** Included allowance exhausted: the figure is money actually being spent. */
  | "plan_overage"
  /** Subscription, but plan utilization could not be read. */
  | "plan_unknown";

export function resolveCostBasis(
  billingMode: BillingMode,
  plan: PlanUsageSummary | null,
): CostBasis {
  if (billingMode === "metered") return "metered";
  if (!plan) return "plan_unknown";
  if (!planAtIncludedLimit(plan)) return "plan_included";
  // `extraUsageEnabled === false` means the provider refuses the request
  // rather than billing for it, so nothing is being spent.
  return plan.extraUsageEnabled === false ? "plan_included" : "plan_overage";
}

/** True when the figure is money charged, rather than a list-price estimate. */
export function costBasisIsCharged(basis: CostBasis): boolean {
  return basis === "metered" || basis === "plan_overage";
}

/** Stat label beside the figure — says which of the two things it is. */
export function costBasisStatLabel(basis: CostBasis): string {
  return costBasisIsCharged(basis) ? "cost" : "list";
}

/** Note under a running turn. Never claims "included" once the plan is spent. */
export function costBasisRunningNote(basis: CostBasis): string {
  switch (basis) {
    case "metered":
      return "Cost is billed when the turn finishes.";
    case "plan_overage":
      return "Billed on top of your plan when the turn finishes.";
    case "plan_included":
      return "Counts toward your plan when the turn finishes.";
    case "plan_unknown":
      return "Counts toward your plan; extra usage is billed on top.";
  }
}

export function planAtIncludedLimit(plan: PlanUsageSummary): boolean {
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

/**
 * Chat footer totals.
 *
 * The figure is always shown. Suppressing it on a subscription hid real spend
 * from anyone past their included allowance, which is exactly when the number
 * matters most; the wording carries whether it is a charge or a list estimate.
 */
export function formatChatTotalsLine(
  billingMode: BillingMode,
  turns: number,
  cost: number,
  plan: PlanUsageSummary | null = null,
): string {
  const turnLabel = `${turns} turn${turns === 1 ? "" : "s"}`;
  const basis = resolveCostBasis(billingMode, plan);
  const amount = formatCostAmount(cost);

  switch (basis) {
    case "metered":
      return `${turnLabel} · ${amount} this chat`;
    case "plan_overage":
      return `${turnLabel} · ${amount} this chat, on top of your plan`;
    case "plan_included":
      return `${turnLabel} · ≈${amount} at list, included`;
    case "plan_unknown":
      return `${turnLabel} · ≈${amount} at list`;
  }
}

/** Bare amount, with enough precision to stay non-zero on cheap turns. */
export function formatCostAmount(cost: number): string {
  if (!cost) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
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
