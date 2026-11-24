import { describe, expect, it } from "vitest";
import type { PaprPlanSummary } from "../../../src/core/types/paprBilling";
import {
  deriveCloudMemoryStatus,
  formatPaprLoginStatusLine,
  paprCloudStatusDotVariant,
  planNeedsAttention,
} from "../../../ui/utils/cloudMemoryStatus";

function baseSummary(
  overrides: Partial<PaprPlanSummary> = {},
): PaprPlanSummary {
  return {
    planName: "Builder",
    planTier: "developer",
    planFeatures: "Developer plan",
    subscriptionStatus: "active",
    trialEnd: null,
    isTrialPeriod: false,
    cancelAtPeriodEnd: false,
    isWorkspaceOwner: true,
    isWorkspaceAdmin: true,
    canManageBilling: true,
    isMeteredBillingOn: false,
    usage: {
      memoriesCount: 0,
      storageCount: 0,
      memoryStorageCount: 0,
      appStorageCount: 0,
      miniInteractionCount: 0,
    },
    limits: {
      memoriesLimit: 2500,
      miniInteractionLimit: 1000,
      premiumInteractionLimit: 0,
      storageLimit: "1GB",
      price: 0,
      seats: 999,
    },
    warnings: {
      memoriesExceeded: false,
      storageExceeded: false,
      operationsExceeded: false,
      memoriesNearLimit: false,
      storageNearLimit: false,
      operationsNearLimit: false,
    },
    ...overrides,
  };
}

describe("deriveCloudMemoryStatus", () => {
  it("returns null for healthy active subscription", () => {
    expect(deriveCloudMemoryStatus(baseSummary())).toBeNull();
    expect(planNeedsAttention(baseSummary())).toBe(false);
  });

  it("returns paused state when subscription is missing", () => {
    const status = deriveCloudMemoryStatus(
      baseSummary({ subscriptionStatus: undefined }),
    );
    expect(status?.level).toBe("paused");
    expect(status?.label).toBe("Papr Cloud paused");
    expect(status?.detail).toContain("Local chat works");
  });

  it("returns paused state when hard limits are exceeded", () => {
    const status = deriveCloudMemoryStatus(
      baseSummary({
        warnings: {
          ...baseSummary().warnings,
          operationsExceeded: true,
        },
      }),
    );
    expect(status?.level).toBe("paused");
    expect(status?.label).toBe("Plan limit reached");
  });

  it("returns billing mismatch when quota says subscription but plan is active", () => {
    const status = deriveCloudMemoryStatus(baseSummary(), "subscription");
    expect(status?.label).toBe("Papr Cloud sync issue");
  });
});

describe("formatPaprLoginStatusLine", () => {
  it("shows login date when Papr Cloud is healthy", () => {
    const line = formatPaprLoginStatusLine({
      connectedSince: "2026-08-17T00:00:00.000Z",
      cloudStatus: null,
    });
    expect(line.dotClass).toBe("papr-section__dot--connected");
    expect(line.text).toContain("Papr logged in");
    expect(line.text).toContain("Aug");
  });

  it("shows Papr Cloud paused when subscription is inactive", () => {
    const cloudStatus = deriveCloudMemoryStatus(
      baseSummary({ subscriptionStatus: "canceled" }),
    );
    const line = formatPaprLoginStatusLine({
      connectedSince: "2026-08-17T00:00:00.000Z",
      cloudStatus,
    });
    expect(line.dotClass).toBe("papr-section__dot--paused");
    expect(line.text).toBe("Papr logged in · Papr Cloud paused");
  });

  it("maps cloud status to sidebar dot variant", () => {
    expect(paprCloudStatusDotVariant(null)).toBe("connected");
    expect(
      paprCloudStatusDotVariant(
        deriveCloudMemoryStatus(baseSummary({ subscriptionStatus: "canceled" })),
      ),
    ).toBe("paused");
  });
});

describe("memoryPaused only on paused level", () => {
  it("metered overage is a warning, not a pause", async () => {
    const { deriveCloudMemoryStatus } = await import("../../../ui/utils/cloudMemoryStatus");
    const summary = {
      subscriptionStatus: "active",
      isMeteredBillingOn: true,
      usage: { miniInteractionCount: 23150, memoriesCount: 3953, storageCount: 0 },
      limits: { miniInteractionLimit: 20000, memoriesLimit: 50000, storageLimit: "10GB" },
      warnings: {
        operationsExceeded: false, memoriesExceeded: false, storageExceeded: false,
        operationsNearLimit: true, memoriesNearLimit: false, storageNearLimit: false,
      },
    } as never;
    const status = deriveCloudMemoryStatus(summary);
    expect(status?.level).toBe("warning");
    expect(status?.level === "paused").toBe(false);
  });
});
