import { describe, expect, it } from "vitest";
import { guessChatGptPlan, guessClaudePlan, monthTotal } from "../../ui/utils/planPricing.js";
import {
  parseClaudePlanInfo,
  parseClaudeUsagePayload,
  readExtraUsageSpent,
} from "../../src/core/services/claudeOAuthUsage.js";

describe("guessClaudePlan", () => {
  it("reads a Team premium seat from the profile's rate-limit tier", () => {
    expect(
      guessClaudePlan({ organizationType: "claude_team", rateLimitTier: "default_claude_max_5x" }),
    ).toEqual({ label: "Team · Premium seat", monthlyUsd: 125 });
  });
  it("reads a Team standard seat", () => {
    expect(guessClaudePlan({ organizationType: "claude_team", rateLimitTier: "default_claude_team" }))
      .toEqual({ label: "Team · Standard seat", monthlyUsd: 25 });
  });
  it("reads Pro / Max / Ultra", () => {
    expect(guessClaudePlan({ organizationType: "claude_pro" })?.monthlyUsd).toBe(20);
    expect(guessClaudePlan({ organizationType: "claude_max", rateLimitTier: "default_claude_max_5x" })?.monthlyUsd).toBe(100);
    expect(guessClaudePlan({ organizationType: "claude_max", rateLimitTier: "default_claude_max_20x" })?.monthlyUsd).toBe(200);
  });
  it("does not invent an Enterprise price", () => {
    expect(guessClaudePlan({ organizationType: "claude_enterprise" })?.monthlyUsd).toBeNull();
  });
  it("returns null with nothing to go on", () => {
    expect(guessClaudePlan(null)).toBeNull();
    expect(guessClaudePlan({})).toBeNull();
  });
});

describe("guessChatGptPlan", () => {
  it("maps plan_type to a list price", () => {
    expect(guessChatGptPlan("plus")).toEqual({ label: "Plus", monthlyUsd: 20 });
    expect(guessChatGptPlan("pro")?.monthlyUsd).toBe(100);
    expect(guessChatGptPlan("business")?.monthlyUsd).toBeNull();
    expect(guessChatGptPlan(null)).toBeNull();
  });
});

describe("monthTotal", () => {
  it("adds plan prices to what was billed on top", () => {
    expect(monthTotal({ planUsd: [125, 20], apiKeyUsd: 2.62, paprUsd: 0, providerExtraUsd: 0 }))
      .toEqual({ plans: 145, extra: 2.62, total: 147.62, plansKnown: true });
  });
  it("flags an unknown plan price instead of treating it as free", () => {
    expect(monthTotal({ planUsd: [null], apiKeyUsd: 0, paprUsd: 0, providerExtraUsd: 5 }).plansKnown).toBe(false);
  });
});

describe("Claude usage payload: extra usage and plan", () => {
  it("reads spend.used in minor units", () => {
    expect(readExtraUsageSpent({ spend: { used: { amount_minor: 1234, currency: "USD", exponent: 2 } } }))
      .toEqual({ amount: 12.34, currency: "USD" });
  });
  it("falls back to extra_usage.used_credits", () => {
    expect(readExtraUsageSpent({ extra_usage: { used_credits: 500, decimal_places: 2, currency: "USD" } }))
      .toEqual({ amount: 5, currency: "USD" });
  });
  it("is null when the response has no spend (the old skip_spend=1 shape)", () => {
    expect(readExtraUsageSpent({ extra_usage: null, spend: null })).toBeNull();
  });
  it("carries extra-usage state through the parser", () => {
    const snap = parseClaudeUsagePayload(
      {
        limits: [{ kind: "session", group: "session", percent: 4, is_active: false }],
        extra_usage: { is_enabled: false, monthly_limit: null },
        spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 } },
      },
      "oauth",
    );
    expect(snap.extraUsageEnabled).toBe(false);
    expect(snap.extraUsageSpent).toEqual({ amount: 0, currency: "USD" });
    expect(snap.extraUsageMonthlyLimit).toBeNull();
  });
  it("reads the plan from the profile", () => {
    expect(
      parseClaudePlanInfo({
        organization: { organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x", seat_tier: "team_tier_1" },
      }),
    ).toEqual({ organizationType: "claude_team", rateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1" });
    expect(parseClaudePlanInfo({})).toBeNull();
  });
});
