import { describe, expect, it } from "vitest";
import {
  PENDING_PLAN_TTL_MS,
  isFreshPlanChoice,
  parsePlanChoice,
  planChoiceName,
} from "./paprPlanLink";

const NOW = 1_800_000_000_000;

describe("parsePlanChoice", () => {
  it("reads plan and track from a papr://billing link", () => {
    expect(parsePlanChoice("papr://billing?plan=cloud_plus&track=team", NOW)).toEqual({
      plan: "cloud_plus",
      track: "team",
      at: NOW,
    });
  });

  it("works for the dev scheme too", () => {
    expect(parsePlanChoice("papr-dev://billing?plan=cloud", NOW)?.plan).toBe("cloud");
  });

  it("defaults the track to individual", () => {
    expect(parsePlanChoice({ plan: "cloud_max" }, NOW)?.track).toBe("individual");
  });

  it("ignores links without a sellable plan", () => {
    expect(parsePlanChoice("papr://billing", NOW)).toBeNull();
    expect(parsePlanChoice("papr://billing?plan=enterprise", NOW)).toBeNull();
    expect(parsePlanChoice("papr://billing?plan=local", NOW)).toBeNull();
    expect(parsePlanChoice("not a url", NOW)).toBeNull();
    expect(parsePlanChoice(null, NOW)).toBeNull();
  });

  it("ignores an unknown track", () => {
    expect(parsePlanChoice({ plan: "cloud", track: "org" }, NOW)?.track).toBe("individual");
  });
});

describe("isFreshPlanChoice", () => {
  const choice = { plan: "cloud", track: "team", at: NOW };

  it("accepts a recent, valid choice", () => {
    expect(isFreshPlanChoice(choice, NOW + 1000)).toBe(true);
  });

  it("expires after the TTL", () => {
    expect(isFreshPlanChoice(choice, NOW + PENDING_PLAN_TTL_MS)).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(isFreshPlanChoice({ ...choice, plan: "gold" }, NOW)).toBe(false);
    expect(isFreshPlanChoice({ ...choice, at: "yesterday" }, NOW)).toBe(false);
    expect(isFreshPlanChoice("cloud", NOW)).toBe(false);
  });
});

describe("planChoiceName", () => {
  it("uses the catalog name", () => {
    expect(planChoiceName("cloud_plus")).toBe("Cloud Max 5x");
  });
});
