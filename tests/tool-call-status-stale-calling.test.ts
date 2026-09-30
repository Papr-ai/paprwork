import { describe, expect, it } from "vitest";
import { resolveToolCallStatus } from "../src/core/utils/interruptedToolResult.js";
import {
  isTransientMiniAppNetworkError,
  shouldSuppressMiniAppRuntimeBanner,
} from "../ui/utils/previewNetworkErrors";

describe("resolveToolCallStatus stale calling", () => {
  it("treats calling + persisted result as success", () => {
    expect(
      resolveToolCallStatus({
        explicitStatus: "calling",
        result: { success: true, pushed: true },
      }),
    ).toBe("success");
  });

  it("keeps calling when no result yet", () => {
    expect(
      resolveToolCallStatus({
        explicitStatus: "calling",
        result: undefined,
      }),
    ).toBe("calling");
  });
});

describe("previewNetworkErrors", () => {
  it("detects failed to fetch", () => {
    expect(isTransientMiniAppNetworkError("Failed to fetch")).toBe(true);
  });

  it("suppresses banner while waiting for gateway", () => {
    expect(
      shouldSuppressMiniAppRuntimeBanner({
        message: "Failed to fetch",
        waitingForGateway: true,
        gatewaySupervisorStarting: false,
        gatewaySupervisorReady: false,
      }),
    ).toBe(true);
  });

  it("shows banner for real errors when gateway is ready", () => {
    expect(
      shouldSuppressMiniAppRuntimeBanner({
        message: "ReferenceError: foo is not defined",
        waitingForGateway: false,
        gatewaySupervisorStarting: false,
        gatewaySupervisorReady: true,
      }),
    ).toBe(false);
  });
});
