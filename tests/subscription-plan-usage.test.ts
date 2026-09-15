import { describe, expect, it } from "vitest";
import {
  chatModelIsFable,
  CLAUDE_PLAN_USAGE_SUBLINE,
  formatChatTotalsLine,
  formatClaudeSubscriptionSubline,
  getPlanUsageHeroLines,
  getPlanUsageTooltipLines,
  summarizeClaudePlanUsage,
} from "../ui/utils/subscriptionPlanUsage.js";

describe("summarizeClaudePlanUsage", () => {
  it("extracts session and weekly rows", () => {
    const summary = summarizeClaudePlanUsage({
      fetchedAt: "2026-01-01T00:00:00.000Z",
      source: "oauth",
      rows: [
        {
          id: "session",
          label: "Current session",
          percent: 3,
          resetsAt: null,
          severity: "normal",
          isActive: false,
        },
        {
          id: "weekly_all",
          label: "All models",
          percent: 17,
          resetsAt: null,
          severity: "normal",
          isActive: true,
        },
        {
          id: "weekly_scoped:Fable",
          label: "Fable",
          percent: 0,
          resetsAt: null,
          severity: "normal",
          isActive: false,
        },
      ],
      extraUsageEnabled: false,
      subscriptionType: "max",
    });
    expect(summary.sessionPercent).toBe(3);
    expect(summary.weeklyPercent).toBe(17);
    expect(summary.weeklyIsActive).toBe(true);
    expect(summary.scopedWeekly).toHaveLength(1);
    expect(summary.extraUsageEnabled).toBe(false);
  });
});

describe("formatClaudeSubscriptionSubline", () => {
  const basePlan = {
    sessionPercent: 100,
    weeklyPercent: 17,
    sessionIsActive: true,
    weeklyIsActive: false,
    scopedWeekly: [] as const,
    activePercent: 100,
    activeLabel: "Current session",
    subscriptionType: "max" as const,
    extraUsageEnabled: false as boolean | null,
    fetchedAt: "",
  };

  it("uses default copy when plan is null", () => {
    expect(formatClaudeSubscriptionSubline(null)).toBe(
      CLAUDE_PLAN_USAGE_SUBLINE,
    );
  });

  it("shows extra-usage billing when at limit and overage is enabled", () => {
    expect(
      formatClaudeSubscriptionSubline({
        ...basePlan,
        extraUsageEnabled: true,
      }),
    ).toBe("Extra usage · billed on top of your plan");
  });

  /**
   * Changed deliberately from "extra usage is off".
   *
   * That phrase names Anthropic's mechanism, and this line now also renders
   * for ChatGPT, which stops by running out of credits rather than by having
   * a setting switched off. The two mechanisms differ; what the user needs to
   * know does not, so the copy states the consequence instead. The assertion
   * this replaces pinned the phrasing, not a requirement.
   */
  it("says nothing more is being spent when refused at the limit", () => {
    expect(formatClaudeSubscriptionSubline(basePlan)).toBe(
      "At included limit · no additional cost",
    );
  });

  it("shows tier + included when under limit", () => {
    expect(
      formatClaudeSubscriptionSubline({
        ...basePlan,
        sessionPercent: 40,
        extraUsageEnabled: true,
      }),
    ).toBe(`max · ${CLAUDE_PLAN_USAGE_SUBLINE}`);
  });
});

describe("getPlanUsageHeroLines", () => {
  const samplePlan = {
    sessionPercent: 0,
    weeklyPercent: 17,
    sessionIsActive: false,
    weeklyIsActive: true,
    scopedWeekly: [{ label: "Fable", percent: 0, isActive: false }],
    activePercent: 17,
    activeLabel: "All models",
    subscriptionType: "max",
    extraUsageEnabled: false,
    fetchedAt: "",
  };

  it("labels each window so percent is never bare", () => {
    const lines = getPlanUsageHeroLines(samplePlan);
    expect(lines.map((l) => l.label)).toEqual([
      "Session (5h)",
      "Weekly (all models)",
    ]);
    expect(lines.find((l) => l.key === "weekly_all")?.isActive).toBe(true);
  });

  it("includes Weekly (Fable) only when the chat model is Fable", () => {
    const withFable = getPlanUsageHeroLines(samplePlan, {
      includeFableWeekly: true,
    });
    expect(withFable.map((l) => l.label)).toContain("Weekly (Fable)");

    const withoutFable = getPlanUsageHeroLines(samplePlan, {
      includeFableWeekly: false,
    });
    expect(withoutFable.map((l) => l.label)).not.toContain("Weekly (Fable)");
  });
});

describe("getPlanUsageTooltipLines", () => {
  it("includes labeled percents and settings note", () => {
    const lines = getPlanUsageTooltipLines({
      sessionPercent: 3,
      weeklyPercent: 17,
      sessionIsActive: false,
      weeklyIsActive: true,
      scopedWeekly: [],
      activePercent: 17,
      activeLabel: "All models",
      subscriptionType: "max",
      extraUsageEnabled: false,
      fetchedAt: "",
    });
    expect(lines[0]).toBe("3% · Session (5h)");
    expect(lines[1]).toBe("17% · Weekly (all models)");
    expect(lines.some((l) => l.includes("Settings"))).toBe(true);
  });
});

describe("chatModelIsFable", () => {
  it("matches Fable model ids", () => {
    expect(chatModelIsFable("claude-fable-5-1")).toBe(true);
    expect(chatModelIsFable("claude-opus-5")).toBe(false);
  });
});

describe("formatChatTotalsLine", () => {
  /**
   * This assertion previously pinned `"5 turns · included usage"` — the dollar
   * figure suppressed for every subscription chat. Corrected deliberately: a
   * subscription login is only "included" up to its allowance, after which the
   * provider bills per token on top of the plan. Suppressing the number hid
   * real spend from exactly the users past that point, so the figure is now
   * always shown and the wording carries whether it is a charge or an estimate.
   */
  it("shows the figure as list price while inside the plan", () => {
    expect(formatChatTotalsLine("subscription", 5, 12.34)).toBe(
      "5 turns · ≈$12.34 at list",
    );
  });
});
