import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { recoveryBannerSurvivesStreamEnd } from "../ui/lib/streamRecoveryPersistence";
import {
  costBasisIsCharged,
  costBasisRunningNote,
  costBasisStatLabel,
  formatChatTotalsLine,
  formatCostAmount,
  resolveCostBasis,
  type PlanUsageSummary,
} from "../ui/utils/subscriptionPlanUsage";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strip comments so a static assertion cannot be satisfied by prose. */
function stripComments(source: string): string {
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function plan(over: Partial<PlanUsageSummary> = {}): PlanUsageSummary {
  return {
    sessionPercent: 10,
    weeklyPercent: 10,
    sessionIsActive: true,
    weeklyIsActive: false,
    scopedWeekly: [],
    activePercent: 10,
    activeLabel: "Current session",
    subscriptionType: "max",
    extraUsageEnabled: null,
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

describe("recovery banner survives the stream's terminal chunk", () => {
  /**
   * The reported failure: a 429 raised the banner and the `done` chunk that
   * always follows (Issue 49) cleared it milliseconds later, so the user saw
   * no reply and no explanation.
   */
  it("keeps a rate-limit banner when done arrives", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: "rateLimit",
      }),
    ).toBe(true);
  });

  it("clears a connection banner when done arrives", () => {
    // A connection banner is raised while output is still expected, so a
    // `done` that does arrive is evidence the stream finished.
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: "connectionLost",
      }),
    ).toBe(false);
  });

  it("does nothing when no banner is up", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: false,
        reason: "rateLimit",
      }),
    ).toBe(false);
  });

  it("clears when the reason was never recorded", () => {
    expect(
      recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: true,
        reason: undefined,
      }),
    ).toBe(false);
  });

  it("useAgent guards the done-path clear rather than clearing unconditionally", () => {
    const source = stripComments(read("ui/hooks/useAgent.ts"));
    expect(source).toContain("recoveryBannerSurvivesStreamEnd");
    // The bare unconditional clear on the done path is what erased the error.
    const guarded = source.indexOf("recoveryBannerSurvivesStreamEnd({");
    expect(guarded).toBeGreaterThan(-1);
  });
});

describe("cost basis is decided by plan utilization, not by credential", () => {
  /**
   * The reported complaint: an OAuth login past its $200 allowance is spending
   * real money per turn, and the UI called it "included usage". Which
   * credential authenticated says nothing about whether the plan is spent.
   */
  it("treats an exhausted subscription as overage", () => {
    expect(
      resolveCostBasis("subscription", plan({ sessionPercent: 100 })),
    ).toBe("plan_overage");
  });

  it("treats a subscription inside its allowance as included", () => {
    expect(
      resolveCostBasis("subscription", plan({ sessionPercent: 42 })),
    ).toBe("plan_included");
  });

  it("does not claim overage when the provider refuses extra usage", () => {
    // extraUsageEnabled === false means the request is rejected rather than
    // billed, so nothing is being spent.
    expect(
      resolveCostBasis(
        "subscription",
        plan({ sessionPercent: 100, extraUsageEnabled: false }),
      ),
    ).toBe("plan_included");
  });

  it("reports unknown rather than guessing when plan usage is unreadable", () => {
    expect(resolveCostBasis("subscription", null)).toBe("plan_unknown");
  });

  it("leaves metered billing alone", () => {
    expect(resolveCostBasis("metered", null)).toBe("metered");
    expect(resolveCostBasis("metered", plan({ sessionPercent: 100 }))).toBe(
      "metered",
    );
  });

  it("separates a charge from a list-price estimate", () => {
    expect(costBasisIsCharged("metered")).toBe(true);
    expect(costBasisIsCharged("plan_overage")).toBe(true);
    expect(costBasisIsCharged("plan_included")).toBe(false);
    expect(costBasisIsCharged("plan_unknown")).toBe(false);
  });

  it("labels the stat so the figure cannot be misread", () => {
    expect(costBasisStatLabel("plan_overage")).toBe("cost");
    expect(costBasisStatLabel("plan_included")).toBe("list");
  });

  it("never tells an over-limit user the turn is free", () => {
    expect(costBasisRunningNote("plan_overage")).toContain("on top of your plan");
    expect(costBasisRunningNote("plan_overage")).not.toContain("Counts toward");
  });
});

describe("the dollar figure is always shown", () => {
  it("shows spend on a subscription chat", () => {
    const line = formatChatTotalsLine(
      "subscription",
      12,
      8.43,
      plan({ sessionPercent: 100 }),
    );
    expect(line).toContain("$8.43");
    expect(line).toContain("on top of your plan");
  });

  it("marks an in-plan figure as list price", () => {
    const line = formatChatTotalsLine(
      "subscription",
      3,
      1.5,
      plan({ sessionPercent: 10 }),
    );
    expect(line).toContain("$1.50");
    expect(line).toContain("at list");
  });

  it("no longer suppresses the amount as 'included usage'", () => {
    // The old line for every subscription chat, regardless of spend.
    expect(formatChatTotalsLine("subscription", 3, 1.5, null)).not.toBe(
      "3 turns · included usage",
    );
  });

  it("keeps metered wording unchanged", () => {
    expect(formatChatTotalsLine("metered", 1, 2.5)).toBe("1 turn · $2.50 this chat");
  });

  it("keeps cheap turns from rounding to zero", () => {
    // A 4-decimal floor: $0.0012 shown as $0.00 reads as free.
    expect(formatCostAmount(0.0012)).toBe("$0.0012");
    expect(formatCostAmount(0.25)).toBe("$0.250");
    expect(formatCostAmount(12.5)).toBe("$12.50");
    expect(formatCostAmount(0)).toBe("$0");
  });

  it("TurnCostStrip no longer gates the stat on billing mode", () => {
    const source = stripComments(read("ui/components/Chat/TurnCostStrip.tsx"));
    expect(source).not.toContain('billingMode === "metered" ? (');
    expect(source).toContain("costBasisStatLabel(basis)");
  });

  it("the plan hero leads with money once the allowance is spent", () => {
    const source = stripComments(
      read("ui/components/Chat/ContextPlanUsageHero.tsx"),
    );
    expect(source).toContain('=== "plan_overage"');
    expect(source).toContain("formatCostAmount(lastTurnCost)");
  });
});
