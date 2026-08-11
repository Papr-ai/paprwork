import { describe, it, expect } from "vitest";
import {
  buildPlanWarnings,
  getPlanLimitsForTier,
  hasActivePaprSubscription,
  normalizePlanTier,
  planDisplayName,
  resolvePlanTierForBilling,
  resolvePlanTierFromSources,
  storageLimitToBytes,
  usageBarPercent,
} from "../src/core/utils/paprPlanLimits.js";

describe("paprPlanLimits", () => {
  it("normalizes dashboard plan nicknames", () => {
    expect(normalizePlanTier("Papr Starter Monthly")).toBe("starter");
    expect(normalizePlanTier("memory intelligence")).toBe("intelligence");
    expect(normalizePlanTier(undefined)).toBe("developer");
  });

  it("does not treat subscription status as a plan tier", () => {
    expect(
      resolvePlanTierFromSources({
        labels: [null, undefined, "active", "trialing"],
      }),
    ).toBe("developer");
  });

  it("maps enterprise org plan_tier to intelligence tier", () => {
    expect(normalizePlanTier("enterprise")).toBe("intelligence");
    expect(
      resolvePlanTierForBilling({
        stripeStatus: "active",
        stripePlanNickname: null,
        fallbackLabels: ["enterprise", "developer"],
      }),
    ).toBe("intelligence");
  });

  it("prefers active Stripe nickname over stale Parse developer tier", () => {
    expect(
      resolvePlanTierForBilling({
        stripeStatus: "active",
        stripePlanNickname: "Papr Growth Monthly",
        fallbackLabels: ["developer", "developer"],
      }),
    ).toBe("growth");
  });

  it("falls back to Parse labels when Stripe nickname is missing", () => {
    expect(
      resolvePlanTierForBilling({
        stripeStatus: "active",
        stripePlanNickname: null,
        fallbackLabels: ["Business Plus", "developer"],
      }),
    ).toBe("growth");
  });

  it("prefers Stripe nickname over Parse fields", () => {
    expect(
      resolvePlanTierFromSources({
        labels: [
          "Papr Growth Monthly",
          "developer",
          "developer",
        ],
      }),
    ).toBe("growth");
  });

  it("picks highest tier when multiple subscriptions exist", () => {
    expect(
      resolvePlanTierFromSources({
        labels: ["Business Plus", "Papr - Memory Intelligence"],
      }),
    ).toBe("intelligence");
  });

  it("maps business plus to growth tier limits", () => {
    expect(normalizePlanTier("business_plus")).toBe("growth");
    expect(normalizePlanTier("Business Plus")).toBe("growth");
  });

  it("maps tiers to display names", () => {
    expect(planDisplayName("growth")).toBe("Growth");
  });

  it("suppresses exceeded warnings when metered billing is on", () => {
    const limits = getPlanLimitsForTier("developer");
    const warnings = buildPlanWarnings(
      {
        memoriesCount: 2400,
        storageCount: storageLimitToBytes("1GB") * 0.95,
        miniInteractionCount: 1000,
      },
      limits,
      { isMeteredBillingOn: true },
    );
    expect(warnings.memoriesExceeded).toBe(false);
    expect(warnings.operationsExceeded).toBe(false);
    expect(warnings.memoriesNearLimit).toBe(true);
  });

  it("computes usage warnings without metered billing", () => {
    const limits = getPlanLimitsForTier("developer");
    const warnings = buildPlanWarnings(
      {
        memoriesCount: 2400,
        storageCount: storageLimitToBytes("1GB") * 0.95,
        miniInteractionCount: 1000,
      },
      limits,
    );
    expect(warnings.memoriesNearLimit).toBe(true);
    expect(warnings.operationsExceeded).toBe(true);
  });

  it("caps usage bars at 100%", () => {
    expect(usageBarPercent(2000, 1000)).toBe(100);
  });

  it("detects active subscription the same way Settings metered billing does", () => {
    expect(hasActivePaprSubscription({ subscriptionStatus: "active" })).toBe(true);
    expect(hasActivePaprSubscription({ subscriptionStatus: "trialing" })).toBe(true);
    expect(hasActivePaprSubscription({ subscriptionStatus: "past_due" })).toBe(false);
    expect(hasActivePaprSubscription({ subscriptionStatus: undefined })).toBe(false);
  });
});
