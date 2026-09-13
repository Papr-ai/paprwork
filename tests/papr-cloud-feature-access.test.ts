import { describe, expect, it } from "vitest";
import {
  buildPaprCloudAccessContext,
  resolvePaprCloudFeatureAccess,
} from "../src/core/utils/paprCloudFeatureAccess.js";

const activeCtx = buildPaprCloudAccessContext({
  isLoggedIn: true,
  subscriptionStatus: "active",
  cloudSyncEnabled: true,
  memoryPaused: false,
});

describe("resolvePaprCloudFeatureAccess", () => {
  it("allows memory features with active subscription", () => {
    expect(resolvePaprCloudFeatureAccess("memory_search", activeCtx).allowed).toBe(
      true,
    );
    expect(resolvePaprCloudFeatureAccess("papr_ai_proxy", activeCtx).allowed).toBe(
      true,
    );
  });

  it("requires login for community install only", () => {
    const loggedOut = buildPaprCloudAccessContext({
      isLoggedIn: false,
      subscriptionStatus: null,
      cloudSyncEnabled: false,
    });
    const loggedInNoSub = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: null,
      cloudSyncEnabled: false,
    });

    expect(
      resolvePaprCloudFeatureAccess("community_install", loggedOut).lockReason,
    ).toBe("login_required");
    expect(
      resolvePaprCloudFeatureAccess("community_install", loggedInNoSub).allowed,
    ).toBe(true);
  });

  it("requires subscription for cloud sync", () => {
    const loggedInNoSub = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "canceled",
      cloudSyncEnabled: false,
    });
    const result = resolvePaprCloudFeatureAccess("cloud_sync", loggedInNoSub);
    expect(result.allowed).toBe(false);
    expect(result.lockReason).toBe("subscription_required");
    expect(result.lockAction).toBe("open_plan");
  });

  it("requires cloud sync toggle for publish", () => {
    const noSync = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "active",
      cloudSyncEnabled: false,
    });
    const result = resolvePaprCloudFeatureAccess("publish_share", noSync);
    expect(result.allowed).toBe(false);
    expect(result.lockReason).toBe("cloud_sync_required");
  });

  it("blocks memory when paused despite active subscription", () => {
    const paused = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: "active",
      cloudSyncEnabled: true,
      memoryPaused: true,
    });
    const result = resolvePaprCloudFeatureAccess("memory_add", paused);
    expect(result.allowed).toBe(false);
    expect(result.lockReason).toBe("memory_paused");
  });

  it("does not require subscription for contribute", () => {
    const loggedInNoSub = buildPaprCloudAccessContext({
      isLoggedIn: true,
      subscriptionStatus: null,
      cloudSyncEnabled: false,
    });
    expect(
      resolvePaprCloudFeatureAccess("community_contribute", loggedInNoSub)
        .allowed,
    ).toBe(true);
  });
});
