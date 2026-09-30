export type BillingMode = "metered" | "subscription";

/**
 * Which subscription the plan figures describe.
 *
 * Carried on the summary rather than passed alongside it: the brand label and
 * the percentages have to agree, and two separate props can drift apart.
 */
export type PlanProvider = "anthropic" | "openai";

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

/** Input from IPC (see codexOAuthUsage.ts) — ChatGPT/Codex plan windows. */
export type CodexUsageLimitsSnapshotInput = {
  fetchedAt: string;
  rows: Array<{
    id: string;
    label: string;
    percent: number;
    isActive: boolean;
  }>;
  /** Credits past the included window: real spend, or a refusal. */
  extraUsageEnabled?: boolean | null;
  subscriptionType?: string | null;
};

/** Compact plan snapshot for the context panel (from Settings usage API). */
export type PlanUsageSummary = {
  provider: PlanProvider;
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

/** Brand shown above "Plan usage" — names whose allowance is being reported. */
export function planUsageBrand(provider: PlanProvider): string {
  return provider === "openai" ? "ChatGPT" : CLAUDE_PLAN_USAGE_BRAND;
}

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
    provider: "anthropic",
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
 * ChatGPT/Codex plan usage.
 *
 * `codexOAuthUsage.ts` already normalises the ChatGPT payload's windows into
 * the same `session` / `weekly_all` ids Anthropic uses, so the row walk is
 * shared rather than duplicated — the two providers differ in where the
 * numbers come from, not in what they mean once read. ChatGPT reports no
 * model-scoped window, so `scopedWeekly` is always empty here.
 */
export function summarizeCodexPlanUsage(
  data: CodexUsageLimitsSnapshotInput,
): PlanUsageSummary {
  const base = summarizeClaudePlanUsage({
    fetchedAt: data.fetchedAt,
    rows: data.rows,
    extraUsageEnabled: data.extraUsageEnabled,
    subscriptionType: data.subscriptionType,
  });
  return { ...base, provider: "openai" };
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

/**
 * A model-scoped weekly window (Anthropic's Fable row) only constrains that
 * model, so counting it while another model is selected would report an
 * additional cost that is not being charged. The hero rows already gate on
 * this; the basis has to use the same rule or the headline and the breakdown
 * disagree. Absent, the row counts — that direction over-states the charge,
 * which is recoverable, where under-stating it is the defect this exists for.
 */
export type CostBasisOptions = {
  scopedWeeklyApplies?: boolean;
};

export function resolveCostBasis(
  billingMode: BillingMode,
  plan: PlanUsageSummary | null,
  options?: CostBasisOptions,
): CostBasis {
  if (billingMode === "metered") return "metered";
  if (!plan) return "plan_unknown";
  if (!planAtIncludedLimit(plan, options)) return "plan_included";
  // `extraUsageEnabled === false` means the provider refuses the request
  // rather than billing for it, so nothing is being spent. `null` is not the
  // same as `false`: we could not read the setting, and at the limit the
  // likelier of the two is that spend is continuing.
  return plan.extraUsageEnabled === false ? "plan_included" : "plan_overage";
}

/** True when the figure is money charged, rather than a list-price estimate. */
export function costBasisIsCharged(basis: CostBasis): boolean {
  return basis === "metered" || basis === "plan_overage";
}

/** False while inside the included allowance — no dollar figure in the UI. */
export function costBasisShowsDollarFigure(basis: CostBasis): boolean {
  return basis !== "plan_included";
}

/** Stat label beside the figure — says which of the two things it is. */
export function costBasisStatLabel(basis: CostBasis): string {
  return costBasisIsCharged(basis) ? "cost" : "list";
}

/**
 * Note under a running turn.
 *
 * The two subscription cases have to be stated in opposite terms, not shaded:
 * inside the allowance the turn costs nothing extra, and past it the turn is
 * real money. Hedged wording covering both ("extra usage is billed on top")
 * reads as reassurance to the person who is spending and as a warning to the
 * person who is not, so it is reserved for the one case where we genuinely
 * cannot tell which they are.
 */
export function costBasisRunningNote(basis: CostBasis): string {
  switch (basis) {
    case "metered":
      return "Cost is billed when the turn finishes.";
    case "plan_overage":
      return "Additional cost — billed on top of your plan.";
    case "plan_included":
      return "No additional cost — included in your plan.";
    case "plan_unknown":
      return "Plan usage unavailable — cannot tell if this is billed on top.";
  }
}

export function planAtIncludedLimit(
  plan: PlanUsageSummary,
  options?: CostBasisOptions,
): boolean {
  const percents: number[] = [];
  if (plan.sessionPercent !== null) percents.push(plan.sessionPercent);
  if (plan.weeklyPercent !== null) percents.push(plan.weeklyPercent);
  if (options?.scopedWeeklyApplies !== false) {
    for (const scoped of plan.scopedWeekly) {
      percents.push(scoped.percent);
    }
  }
  return percents.some((p) => p >= 100);
}

/**
 * Subline under plan usage — reflects included pool vs extra (overage) billing.
 * Plan % still comes from the same usage API when extra usage is on; we do not show $ here.
 */
export function formatClaudeSubscriptionSubline(
  plan: PlanUsageSummary | null,
  options?: CostBasisOptions,
): string {
  if (!plan) {
    return CLAUDE_PLAN_USAGE_SUBLINE;
  }

  const brand = planUsageBrand(plan.provider);
  const included = `Included · shared across ${brand}`;
  const atLimit = planAtIncludedLimit(plan, options);

  if (atLimit && plan.extraUsageEnabled === true) {
    return "Extra usage · billed on top of your plan";
  }
  if (atLimit && plan.extraUsageEnabled === false) {
    // ChatGPT refuses by running out of credits, Anthropic by having extra
    // usage switched off. Both mean the same thing to the user — nothing more
    // is being spent — so the wording says that instead of naming a mechanism
    // that differs per provider.
    return "At included limit · no additional cost";
  }
  if (atLimit) {
    return "At included limit";
  }

  if (plan.subscriptionType) {
    const tier = plan.subscriptionType.replace(/_/g, " ");
    return `${tier} · ${included}`;
  }
  return included;
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
    lines.push(
      formatClaudeSubscriptionSubline(plan, {
        scopedWeeklyApplies: options?.includeFableWeekly ?? true,
      }),
    );
    lines.push(
      plan.provider === "openai"
        ? "Same as the ChatGPT usage Codex reports (whole account)."
        : "Same as claude.ai Settings → Usage (whole account).",
    );
  } else {
    lines.push(CLAUDE_PLAN_USAGE_SUBLINE);
    lines.push("Same as claude.ai Settings → Usage (whole account).");
  }
  return lines;
}

/**
 * Chat footer totals.
 *
 * Overage and metered chats still show dollars. While inside the included
 * allowance, the footer names the outcome only — no list-price estimate.
 */
export function formatChatTotalsLine(
  billingMode: BillingMode,
  turns: number,
  cost: number,
  plan: PlanUsageSummary | null = null,
  options?: CostBasisOptions,
): string {
  const turnLabel = `${turns} turn${turns === 1 ? "" : "s"}`;
  const basis = resolveCostBasis(billingMode, plan, options);
  const amount = formatCostAmount(cost);

  switch (basis) {
    case "metered":
      return `${turnLabel} · ${amount} this chat`;
    case "plan_overage":
      return `${turnLabel} · ${amount} this chat, on top of your plan`;
    case "plan_included":
      return `${turnLabel} · no additional cost`;
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
