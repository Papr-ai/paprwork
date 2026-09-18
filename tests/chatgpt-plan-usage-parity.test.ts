/**
 * Both subscriptions must answer the same question: is this turn costing extra?
 *
 * The Claude half was fixed first, which left ChatGPT with no plan reading at
 * all — so every ChatGPT turn fell to the hero's "Included / Subscription"
 * branch and was declared free regardless of how far past its windows the
 * account was. These tests pin the two providers to the same rule so the
 * next reading added cannot quietly reintroduce the asymmetry.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  costBasisRunningNote,
  formatChatTotalsLine,
  planUsageBrand,
  formatClaudeSubscriptionSubline,
  resolveCostBasis,
  summarizeCodexPlanUsage,
  type PlanProvider,
  type PlanUsageSummary,
} from "../ui/utils/subscriptionPlanUsage";
import {
  codexUsageUrl,
  parseCodexUsagePayload,
} from "../src/core/services/codexOAuthUsage";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function stripComments(source: string): string {
  // Line comments first: a line comment containing `/*` would otherwise open
  // a block the stripper then runs to the next `*/`, deleting real code.
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function plan(
  provider: PlanProvider,
  over: Partial<PlanUsageSummary> = {},
): PlanUsageSummary {
  return {
    provider,
    sessionPercent: 10,
    weeklyPercent: 10,
    sessionIsActive: true,
    weeklyIsActive: false,
    scopedWeekly: [],
    activePercent: 10,
    activeLabel: "Current session",
    subscriptionType: "pro",
    extraUsageEnabled: null,
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

const PROVIDERS: PlanProvider[] = ["anthropic", "openai"];

describe("the basis rule is identical for both subscriptions", () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: under the limit is no additional cost`, () => {
      const basis = resolveCostBasis(
        "subscription",
        plan(provider, { sessionPercent: 42, weeklyPercent: 61 }),
      );
      expect(basis).toBe("plan_included");
      expect(costBasisRunningNote(basis)).toBe(
        "No additional cost — included in your plan.",
      );
    });

    it(`${provider}: past the limit with spend on is an additional cost`, () => {
      const basis = resolveCostBasis(
        "subscription",
        plan(provider, { weeklyPercent: 100, extraUsageEnabled: true }),
      );
      expect(basis).toBe("plan_overage");
      expect(costBasisRunningNote(basis)).toBe(
        "Additional cost — billed on top of your plan.",
      );
    });

    it(`${provider}: past the limit with spend off is not charged`, () => {
      // Anthropic switches extra usage off; ChatGPT runs out of credits.
      // Different mechanisms, same fact: nothing more is being spent.
      const basis = resolveCostBasis(
        "subscription",
        plan(provider, { sessionPercent: 100, extraUsageEnabled: false }),
      );
      expect(basis).toBe("plan_included");
    });

    it(`${provider}: at the limit with an unreadable spend setting is treated as charged`, () => {
      // `null` is not `false`. At the limit the likelier of the two is that
      // spend is continuing, and under-stating the charge is the defect this
      // whole area exists to fix.
      const basis = resolveCostBasis(
        "subscription",
        plan(provider, { sessionPercent: 100, extraUsageEnabled: null }),
      );
      expect(basis).toBe("plan_overage");
    });

    it(`${provider}: an unread plan says so rather than claiming included`, () => {
      const basis = resolveCostBasis("subscription", null);
      expect(basis).toBe("plan_unknown");
      expect(costBasisRunningNote(basis)).toContain("cannot tell");
    });
  }
});

describe("wording names the right subscription", () => {
  it("brands each provider", () => {
    expect(planUsageBrand("openai")).toBe("ChatGPT");
    expect(planUsageBrand("anthropic")).toBe("Claude");
  });

  it("the shared-pool subline uses the provider on the summary", () => {
    expect(formatClaudeSubscriptionSubline(plan("openai"))).toContain(
      "shared across ChatGPT",
    );
    expect(formatClaudeSubscriptionSubline(plan("anthropic"))).toContain(
      "shared across Claude",
    );
  });

  it("states no additional cost when refused at the limit", () => {
    for (const provider of PROVIDERS) {
      expect(
        formatClaudeSubscriptionSubline(
          plan(provider, { weeklyPercent: 100, extraUsageEnabled: false }),
        ),
      ).toBe("At included limit · no additional cost");
    }
  });

  it("totals line says no additional cost inside the plan, and shows spend past it", () => {
    for (const provider of PROVIDERS) {
      expect(
        formatChatTotalsLine("subscription", 4, 3.5, plan(provider)),
      ).toContain("no additional cost");
      expect(
        formatChatTotalsLine(
          "subscription",
          4,
          3.5,
          plan(provider, { weeklyPercent: 100, extraUsageEnabled: true }),
        ),
      ).toContain("on top of your plan");
    }
  });
});

describe("a model-scoped weekly window only bills the model it scopes to", () => {
  const scoped = plan("anthropic", {
    sessionPercent: 20,
    weeklyPercent: 30,
    scopedWeekly: [{ label: "Fable", percent: 100, isActive: true }],
    extraUsageEnabled: true,
  });

  it("counts the scoped row while that model is selected", () => {
    expect(
      resolveCostBasis("subscription", scoped, { scopedWeeklyApplies: true }),
    ).toBe("plan_overage");
  });

  it("ignores it while another model is selected", () => {
    expect(
      resolveCostBasis("subscription", scoped, { scopedWeeklyApplies: false }),
    ).toBe("plan_included");
  });

  it("ChatGPT reports no scoped window, so the option cannot change its basis", () => {
    const chatgpt = plan("openai", {
      weeklyPercent: 100,
      extraUsageEnabled: true,
    });
    expect(
      resolveCostBasis("subscription", chatgpt, { scopedWeeklyApplies: false }),
    ).toBe("plan_overage");
  });
});

describe("reading ChatGPT's usage payload", () => {
  it("maps both windows onto the ids the shared summariser expects", () => {
    const snap = parseCodexUsagePayload({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 47,
          limit_window_seconds: 18_000,
          reset_at: 1_790_000_000,
        },
        secondary_window: {
          used_percent: 100,
          limit_window_seconds: 604_800,
          reset_at: 1_790_500_000,
        },
        credits: { has_credits: true, balance: "$12.00" },
      },
    });

    const summary = summarizeCodexPlanUsage(snap);
    expect(summary.provider).toBe("openai");
    expect(summary.sessionPercent).toBe(47);
    expect(summary.weeklyPercent).toBe(100);
    expect(summary.extraUsageEnabled).toBe(true);
    expect(summary.subscriptionType).toBe("pro");
    // The reported case: weekly spent, credits bought, so money is moving.
    expect(resolveCostBasis("subscription", summary)).toBe("plan_overage");
  });

  it("treats an unlimited entitlement as not spending", () => {
    const snap = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
        credits: { unlimited: true },
      },
    });
    expect(snap.extraUsageEnabled).toBe(false);
    expect(
      resolveCostBasis("subscription", summarizeCodexPlanUsage(snap)),
    ).toBe("plan_included");
  });

  it("leaves spend unknown when the credits block is absent", () => {
    const snap = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 90, limit_window_seconds: 18_000 },
      },
    });
    expect(snap.extraUsageEnabled).toBeNull();
  });

  it("returns no rows for a payload it cannot read", () => {
    // The caller turns zero rows into an explicit "unavailable"; a fabricated
    // 0% would render as the most reassuring number available.
    expect(parseCodexUsagePayload({ nonsense: true }).rows).toHaveLength(0);
    expect(parseCodexUsagePayload(null).rows).toHaveLength(0);
  });

  it("scales the Unix-seconds reset instead of landing in 1970", () => {
    const snap = parseCodexUsagePayload({
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 18_000,
          reset_at: 1_790_000_000,
        },
      },
    });
    expect(snap.rows[0]?.resetsAt?.startsWith("2026-")).toBe(true);
  });

  it("uses the wham path on the ChatGPT backend", () => {
    expect(codexUsageUrl()).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
  });
});

describe("the UI reads whichever subscription is paying", () => {
  it("ChatContainer resolves a provider for OpenAI OAuth as well as Anthropic", () => {
    const source = stripComments(read("ui/components/Chat/ChatContainer.tsx"));
    expect(source).toContain('return "openai"');
    expect(source).toContain('return "anthropic"');
    // The boolean it replaced could only ever describe Claude.
    expect(source).not.toContain("fetchClaudePlanUsage");
  });

  it("ContextMeter fetches from the provider it was given", () => {
    const source = stripComments(read("ui/components/Chat/ContextMeter.tsx"));
    expect(source).toContain("summarizeCodexPlanUsage");
    expect(source).toContain("summarizeClaudePlanUsage");
    expect(source).toContain("getUsageLimits");
  });

  it("the hero no longer declares an unread plan included", () => {
    const source = stripComments(
      read("ui/components/Chat/ContextPlanUsageHero.tsx"),
    );
    expect(source).not.toContain("Subscription</div>");
    expect(source).toContain("usage unavailable");
    // Brand comes from the summary, so it cannot name the wrong provider.
    expect(source).toContain("planUsageBrand(planUsage.provider)");
  });

  it("the strip and the hero resolve the basis with the same options", () => {
    const panel = stripComments(
      read("ui/components/Chat/ContextUsagePanel.tsx"),
    );
    expect(panel).toContain("costBasisOptions={costBasisOptions}");
    expect(panel).toContain("scopedWeeklyApplies: chatModelIsFable(chatModelId)");
  });

  it("the usage IPC falls back to the account id in the token", () => {
    const source = stripComments(read("src/electron/ipc/oauth.ts"));
    expect(source).toContain("extractChatGptAccountIdFromOAuthToken");
  });
});
