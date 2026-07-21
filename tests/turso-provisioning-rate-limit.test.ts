import { describe, expect, it } from "vitest";
import {
  isTursoDatabaseLimitError,
  isTursoProvisioningRateLimitError,
} from "../src/gateway/services/tursoSyncBridgeCore.js";

describe("isTursoProvisioningRateLimitError", () => {
  it("detects 403 provisioning failures", () => {
    const message =
      'Turso token request failed (500): {"detail":"Database provisioning failed: Client error \'403 Forbidden\'';
    expect(isTursoProvisioningRateLimitError(message)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTursoProvisioningRateLimitError("PAPR_API_KEY not configured")).toBe(
      false,
    );
  });

  it("still detects database limit separately", () => {
    expect(isTursoDatabaseLimitError("Turso database limit reached")).toBe(true);
  });

  it("detects Turso org blocked errors", () => {
    expect(
      isTursoDatabaseLimitError(
        "Turso organization is blocked from creating databases. Enable overages",
      ),
    ).toBe(true);
  });
});

describe("tursoPushScheduler queue exports", () => {
  it("exposes reset helper for tests", async () => {
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    expect(typeof mod.resetTursoPushQueueForTests).toBe("function");
    mod.resetTursoPushQueueForTests();
  });
});
