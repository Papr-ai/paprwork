import { describe, expect, it } from "vitest";
import {
  PAPR_CREDIT_PLANS,
  PAPR_EXPERT_BUILDS,
  creditsUsdLabel,
  isCreditPlanId,
  isSelfServeExpertBuild,
  monthlyTotal,
} from "../src/core/types/paprCreditPlans";

describe("credits plan catalog", () => {
  it("matches the memory server rate card (config/credits.yaml)", () => {
    expect(PAPR_CREDIT_PLANS.map((p) => [p.id, p.pricePerSeat, p.creditsPerSeat, p.cloudApps])).toEqual([
      ["cloud", 30, 30_000, 1],
      ["cloud_plus", 100, 150_000, 5],
      ["cloud_max", 300, 500_000, 15],
    ]);
  });

  it("shows the credit grant as a dollar value", () => {
    expect(PAPR_CREDIT_PLANS.map(creditsUsdLabel)).toEqual(["$30", "$150", "$500"]);
  });

  it("prices per seat, never below one seat", () => {
    const cloud = PAPR_CREDIT_PLANS[0]!;
    expect(monthlyTotal(cloud, 3)).toBe(90);
    expect(monthlyTotal(cloud, 0)).toBe(30);
  });

  it("only medium and large Expert Builds are self-serve; XL is quoted", () => {
    expect(PAPR_EXPERT_BUILDS.map((b) => [b.size, b.price])).toEqual([
      ["medium", 500],
      ["large", 1500],
      ["xl", null],
    ]);
    expect(isSelfServeExpertBuild("medium")).toBe(true);
    expect(isSelfServeExpertBuild("xl")).toBe(false);
    expect(isCreditPlanId("cloud_plus")).toBe(true);
    expect(isCreditPlanId("starter")).toBe(false);
  });
});
