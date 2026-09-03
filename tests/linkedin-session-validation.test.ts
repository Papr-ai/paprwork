import { describe, expect, it } from "vitest";
import {
  classifyLinkedInProbeResult,
  isLinkedInSessionAliveFromBrowserUrl,
  isTransientLinkedInProbeError,
  sanitizeLinkedInProbeErrorForDisplay,
  LINKEDIN_PROBE_NETWORK_ERROR_MESSAGE,
} from "../src/gateway/services/platforms/linkedinSessionValidation.js";
import { getPlatformConfig } from "../src/gateway/services/platforms/platformRegistry.js";

describe("classifyLinkedInProbeResult", () => {
  it("rejects login redirect URLs", () => {
    const result = classifyLinkedInProbeResult({
      finalUrl: "https://www.linkedin.com/uas/login?session_redirect=%2Ffeed%2F",
      status: 200,
      bodySnippet: "Sign in",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("redirected to login");
  });

  it("rejects feed redirect loop (302 to feed)", () => {
    const result = classifyLinkedInProbeResult({
      finalUrl: "https://www.linkedin.com/feed/",
      status: 302,
      locationHeader: "https://www.linkedin.com/feed/",
      bodySnippet: "",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("feed redirect loop (session rejected)");
  });

  it("accepts healthy feed response", () => {
    const body = "x".repeat(600);
    const result = classifyLinkedInProbeResult({
      finalUrl: "https://www.linkedin.com/feed/",
      status: 200,
      bodySnippet: body,
    });
    expect(result.accepted).toBe(true);
  });

  it("rejects empty 200 feed body", () => {
    const result = classifyLinkedInProbeResult({
      finalUrl: "https://www.linkedin.com/feed/",
      status: 200,
      bodySnippet: "<html></html>",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("empty feed response");
  });
});

describe("isTransientLinkedInProbeError", () => {
  it("detects ECONNRESET as transient", () => {
    expect(isTransientLinkedInProbeError("apiRequestContext.get: read ECONNRESET")).toBe(true);
  });

  it("does not treat login redirect as transient", () => {
    expect(isTransientLinkedInProbeError("redirected to login")).toBe(false);
  });
});

describe("sanitizeLinkedInProbeErrorForDisplay", () => {
  it("maps transient errors to friendly message", () => {
    expect(
      sanitizeLinkedInProbeErrorForDisplay("apiRequestContext.get: read ECONNRESET Call log:"),
    ).toBe(LINKEDIN_PROBE_NETWORK_ERROR_MESSAGE);
  });

  it("strips cookie headers from probe errors", () => {
    const raw =
      "apiRequestContext.get: failed\n  - cookie: li_at=secret-value; bcookie=abc";
    const sanitized = sanitizeLinkedInProbeErrorForDisplay(raw);
    expect(sanitized).not.toContain("li_at");
    expect(sanitized).not.toContain("cookie:");
  });
});

describe("isLinkedInSessionAliveFromBrowserUrl", () => {
  it("accepts feed URL as alive", () => {
    const config = getPlatformConfig("linkedin");
    expect(config).toBeTruthy();
    expect(
      isLinkedInSessionAliveFromBrowserUrl("https://www.linkedin.com/feed/", config!),
    ).toBe(true);
  });

  it("rejects login URL", () => {
    const config = getPlatformConfig("linkedin");
    expect(
      isLinkedInSessionAliveFromBrowserUrl(
        "https://www.linkedin.com/login",
        config!,
      ),
    ).toBe(false);
  });
});
