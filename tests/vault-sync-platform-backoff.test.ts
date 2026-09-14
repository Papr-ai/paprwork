import { afterEach, describe, expect, it } from "vitest";
import {
  getVaultSyncPlatformPauseReason,
  isVaultSyncPlatformPaused,
  recordVaultSyncPlatformFailure,
  recordVaultSyncPlatformSuccess,
  resetVaultSyncPlatformBackoffForTests,
} from "../src/gateway/services/vaultSyncPlatformBackoff.js";

describe("vaultSyncPlatformBackoff", () => {
  afterEach(() => {
    resetVaultSyncPlatformBackoffForTests();
  });

  it("ignores non-5xx failures", () => {
    recordVaultSyncPlatformFailure(429, "rate limited");
    expect(isVaultSyncPlatformPaused()).toBe(false);
  });

  it("pauses after 500 with increasing cooldown", () => {
    recordVaultSyncPlatformFailure(500, '{"detail":"Internal server error"}');
    expect(isVaultSyncPlatformPaused()).toBe(true);
    expect(getVaultSyncPlatformPauseReason()).toContain("Internal server error");
    recordVaultSyncPlatformSuccess();
    expect(isVaultSyncPlatformPaused()).toBe(false);
  });
});
