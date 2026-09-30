import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PAPR_USAGE_URL,
  extractErrorMessage,
  formatCloudPublishFailureMessage,
  formatPaprQuotaMessage,
  isPaprCloudPaused,
  isPaprQuotaError,
  isPaprSubscriptionBlockedMessage,
  notifyPaprQuotaStatus,
  parsePaprQuotaError,
  reportPaprQuotaError,
  setPaprCloudPaused,
  setPaprQuotaExceededListener,
} from "../src/core/utils/paprQuota.js";

describe("paprQuota", () => {
  beforeEach(() => {
    setPaprQuotaExceededListener(null);
    setPaprCloudPaused(false);
  });

  it("detects operation limit messages from memory server", () => {
    const error = new Error(
      "You've reached the 1,000 mini interactions limit. Visit dashboard.papr.ai to upgrade.",
    );
    expect(isPaprQuotaError(error)).toBe(true);
    const status = parsePaprQuotaError(error, "test");
    expect(status?.kind).toBe("operations");
    expect(status?.billingUrl).toBe(PAPR_USAGE_URL);
    expect(status?.suggestMeteredBilling).toBe(true);
  });

  it("does not treat namespace auth errors as quota", () => {
    const error = {
      name: "PermissionDeniedError",
      status: 403,
      message: "Namespace authorization denied for this API key",
    };
    expect(isPaprQuotaError(error)).toBe(false);
    expect(parsePaprQuotaError(error)).toBeNull();
  });

  it("classifies memory count limits", () => {
    const error = new Error("Active memories limit reached for your plan.");
    const status = parsePaprQuotaError(error);
    expect(status?.kind).toBe("memories");
    expect(status?.title).toBe("Memory limit reached");
  });

  it("formats user-facing tool messages", () => {
    const status = parsePaprQuotaError(
      new Error("Interaction limit reached. Enable metered billing at dashboard.papr.ai"),
    );
    expect(status).not.toBeNull();
    const message = formatPaprQuotaMessage(status!);
    expect(message).toContain("Operations limit reached");
  });

  it("notifies registered listener via reportPaprQuotaError", () => {
    const listener = vi.fn();
    setPaprQuotaExceededListener(listener);

    reportPaprQuotaError(
      new Error("Interaction limit reached for your account."),
      "chat-sync",
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.source).toBe("chat-sync");
  });

  it("extracts nested API error messages", () => {
    const error = {
      message: "Request failed",
      body: {
        message:
          "Storage limit reached. Upgrade at https://dashboard.papr.ai/usage",
      },
    };
    expect(extractErrorMessage(error)).toContain("Storage limit");
    expect(parsePaprQuotaError(error)?.kind).toBe("storage");
  });

  it("parses raw JSON 403 subscription errors into friendly copy", () => {
    const error = new Error(
      '403 {"code":403,"status":"error","data":null,"error":"Please visit https://dashboard.papr.ai to start your free trial and begin using Papr.","details":{"error":"No active subscription","message":"Please visit https://dashboard.papr.ai to start your free trial and begin using Papr."}}',
    );
    expect(isPaprQuotaError(error)).toBe(true);
    const status = parsePaprQuotaError(error, "chat-sync");
    expect(status?.kind).toBe("subscription");
    expect(status?.title).toBe("Subscription cancelled.");
    expect(status?.detail).toContain("Papr Cloud features paused");
    expect(status?.detail).not.toContain('"code"');
    expect(status?.suggestMeteredBilling).toBe(false);
  });

  it("detects compact schema-list subscription JSON without dashboard URL", () => {
    const error = new Error(
      '403 {"success":false,"data":[],"error":"No active subscription","code":403,"total":0}',
    );
    expect(isPaprQuotaError(error)).toBe(true);
    const status = parsePaprQuotaError(error, "schema-list");
    expect(status?.kind).toBe("subscription");
    expect(status?.detail).toContain("Papr Cloud features paused");
    expect(status?.detail).not.toContain('"code"');
  });

  it("never surfaces raw JSON payloads in banner detail", () => {
    const error = new Error(
      '403 {"code":403,"status":"error","error":"Interaction limit reached"}',
    );
    const status = parsePaprQuotaError(error);
    expect(status?.detail).not.toMatch(/^\d{3}\s*\{/);
    expect(status?.detail).not.toContain('"code"');
  });

  it("detects truncated mini interactions JSON without dashboard URL", () => {
    const error = new Error(
      'Cloud publish failed (403): {"detail":"You\'ve reached the 1,000 mini interactions limit for your Developer plan. To continue, upgrade to Starter ($100/mo) or Gr',
    );
    expect(isPaprQuotaError(error)).toBe(true);
    const status = parsePaprQuotaError(error, "cloud-publish");
    expect(status?.kind).toBe("operations");
    expect(status?.detail).toContain("mini interactions limit");
  });

  it("formats cloud publish failure from JSON detail field", () => {
    const message = formatCloudPublishFailureMessage(
      '{"detail":"You\'ve reached the 1,000 mini interactions limit for your Developer plan."}',
      403,
    );
    expect(message).toContain("Operations limit reached");
    expect(message).not.toContain('"detail"');
  });

  it("detects subscription block messages", () => {
    const msg = '403 {"details":{"error":"No active subscription"}}';
    expect(isPaprSubscriptionBlockedMessage(msg)).toBe(true);
    expect(
      isPaprSubscriptionBlockedMessage("Namespace authorization denied"),
    ).toBe(false);
  });

  it("pauses cloud features after subscription quota report", () => {
    expect(isPaprCloudPaused()).toBe(false);
    reportPaprQuotaError(
      new Error('403 {"error":"No active subscription"}'),
      "vault-sync",
    );
    expect(isPaprCloudPaused()).toBe(true);
  });

  it("notifyPaprQuotaStatus forwards to listener", () => {
    const listener = vi.fn();
    setPaprQuotaExceededListener(listener);
    notifyPaprQuotaStatus({
      kind: "operations",
      severity: "exceeded",
      title: "Operations limit reached",
      detail: "Test",
      suggestMeteredBilling: true,
      billingUrl: PAPR_USAGE_URL,
      source: "manual",
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});
