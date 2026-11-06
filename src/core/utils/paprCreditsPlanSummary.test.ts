import { describe, expect, it } from "vitest";
import { buildCreditsPlanSummary, creditsRoleFromBuilders, creditsSummaryFromUsage } from "./paprCreditsPlanSummary.js";
import { hasActivePaprSubscription } from "./paprPlanLimits.js";

const base = { period: "2026-11", credits: 0, usd: 0, userId: "u", organizationId: "o" };

describe("credits plan summary", () => {
  it("legacy org (no allowance) -> null, so the legacy summary is built", () => {
    expect(creditsSummaryFromUsage({ ...base, allowance: null, org: null })).toBeNull();
    expect(creditsSummaryFromUsage(null)).toBeNull();
  });

  it("owner on Cloud: plan name, active, no legacy warnings", () => {
    const credits = creditsSummaryFromUsage({
      ...base,
      allowance: { plan: "cloud", grant: 30000, used: 5210, ratio: 0.17, state: "ok", seat: true },
      org: { plan: "cloud", grant: 30000, used: 5457, ratio: 0.18, state: "ok", seats: 1 },
    })!;
    const s = buildCreditsPlanSummary({ credits, isWorkspaceOwner: true, isWorkspaceAdmin: true });
    expect(s.planName).toBe("Cloud");
    expect(hasActivePaprSubscription(s)).toBe(true);
    expect(s.canManageBilling).toBe(true);
    expect(Object.values(s.warnings).some(Boolean)).toBe(false);
    expect(s.credits?.you).toMatchObject({ grant: 30000, used: 5210, seat: true });
  });

  it("member over cap keeps the block reason and cap", () => {
    const credits = creditsSummaryFromUsage({
      ...base,
      allowance: { plan: "cloud", grant: 0, used: 246, ratio: null, state: "blocked", seat: false,
        reason: "member_cap", memberCap: 50, topupBalanceUsd: 24.93 },
      org: null,
    })!;
    expect(credits.you).toMatchObject({ state: "blocked", reason: "member_cap", seat: false, memberCap: 50 });
    expect(credits.topupBalanceUsd).toBe(24.93);
    const s = buildCreditsPlanSummary({ credits, isWorkspaceOwner: false, isWorkspaceAdmin: false });
    expect(s.canManageBilling).toBe(false);
  });
});

describe("creditsRoleFromBuilders", () => {
  const row = (userId: string, roles: string[]) => ({ userId, roles, seat: true, grant: 0, used: 0, state: "ok", overageCredits: 0, overageUsd: 0 });
  it("owner role in memory -> owner (Parse member list Forbidden case)", () => {
    expect(creditsRoleFromBuilders({ builderUsage: [row("me", ["expert", "member", "owner"])], memberUsage: [] }, "me")).toBe("owner");
  });
  it("view readable but no owner role -> admin", () => {
    expect(creditsRoleFromBuilders({ builderUsage: [row("me", ["admin"])], memberUsage: [] }, "me")).toBe("admin");
    expect(creditsRoleFromBuilders({ builderUsage: [], memberUsage: [] }, "me")).toBe("admin");
  });
  it("no view (403) -> null", () => {
    expect(creditsRoleFromBuilders(null, "me")).toBeNull();
  });
});
