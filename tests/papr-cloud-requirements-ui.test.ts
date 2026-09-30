import { describe, expect, it } from "vitest";
import { buildPaprCloudAccessContext } from "../src/core/utils/paprCloudFeatureAccess";
import {
  buildPaprCloudRequirementRows,
  paprCloudPanelNeedsAttention,
} from "../ui/utils/paprCloudRequirementsUi";

describe("buildPaprCloudRequirementRows", () => {
  it("lists publish_share requirements with fix actions when unmet", () => {
    const ctx = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "canceled",
      cloudSyncEnabled: false,
    });

    const { rows, access } = buildPaprCloudRequirementRows("publish_share", ctx);

    expect(access.allowed).toBe(false);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.requirement === "login")?.met).toBe(true);
    expect(rows.find((row) => row.requirement === "subscription")?.met).toBe(false);
    expect(rows.find((row) => row.requirement === "cloud_sync_enabled")?.met).toBe(
      false,
    );
    expect(
      rows.find((row) => row.requirement === "subscription")?.fixLabel,
    ).toBe("Plan & usage");
  });
});

describe("paprCloudPanelNeedsAttention", () => {
  it("hides the panel when Papr Cloud is healthy", () => {
    const context = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "active",
      cloudSyncEnabled: true,
      memoryPaused: false,
    });

    expect(
      paprCloudPanelNeedsAttention({
        context,
        accessAllowed: true,
        cloudStatus: null,
        planSummary: null,
      }),
    ).toBe(false);
  });

  it("shows the panel when subscription is blocked", () => {
    const context = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "canceled",
      cloudSyncEnabled: true,
    });

    const { access } = buildPaprCloudRequirementRows("publish_share", context);

    expect(
      paprCloudPanelNeedsAttention({
        context,
        accessAllowed: access.allowed,
        cloudStatus: null,
        planSummary: null,
      }),
    ).toBe(true);
  });

  it("shows the panel when cloud sync is off", () => {
    const context = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "active",
      cloudSyncEnabled: false,
      memoryPaused: false,
    });

    const { access } = buildPaprCloudRequirementRows("publish_share", context);

    expect(
      paprCloudPanelNeedsAttention({
        context,
        accessAllowed: access.allowed,
        cloudStatus: null,
        planSummary: null,
      }),
    ).toBe(true);
  });
});
