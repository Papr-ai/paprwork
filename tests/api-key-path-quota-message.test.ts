import { describe, expect, test, vi, afterEach } from "vitest";

import {
  extractErrorCode,
  extractErrorMessage,
} from "../src/gateway/services/agent/streamOrchestrator.js";

/**
 * The AI SDK path (API keys) reported a spent allowance as an ordinary burst
 * limit, because it answered on the status code before reading the body.
 * Anthropic returns a monthly spend cap and a per-minute ceiling with the same
 * 429 and the same `rate_limit_error` type, so the sentence is the only thing
 * that separates them.
 *
 * The pi-ai (OAuth) path was fixed for this in #154; these tests pin the same
 * guarantee on the API-key path.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** The user's real refusal, verbatim from the Anthropic Console. */
const SPEND_CAP_SENTENCE =
  "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.";

function apiCallError(
  statusCode: number,
  providerType: string,
  providerMessage: string,
): Record<string, unknown> {
  return {
    name: "AI_APICallError",
    statusCode,
    url: ANTHROPIC_URL,
    message: "",
    responseBody: JSON.stringify({
      type: "error",
      error: { type: providerType, message: providerMessage },
    }),
  };
}

function retryError(underlying: Record<string, unknown>) {
  return {
    name: "AI_RetryError",
    reason: "maxRetriesExceeded",
    message: "Failed after 3 attempts",
    errors: [underlying],
    lastError: underlying,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spend cap vs burst limit on the API-key path", () => {
  test("a 429 carrying a spend-cap sentence is not reported as a burst limit", () => {
    const message = extractErrorMessage(
      apiCallError(429, "rate_limit_error", SPEND_CAP_SENTENCE),
    );

    expect(message).not.toContain("wait a moment and try again");
    expect(message).toContain("spend limit");
    expect(message).toContain("retrying won't help");
    expect(
      extractErrorCode(apiCallError(429, "rate_limit_error", SPEND_CAP_SENTENCE)),
    ).toBe("provider_quota_exhausted");
  });

  test("the reset date the provider gave is surfaced", () => {
    const message = extractErrorMessage(
      apiCallError(429, "rate_limit_error", SPEND_CAP_SENTENCE),
    );

    expect(message).toContain("Oct 1, 2026");
  });

  test("the provider's own sentence is quoted back", () => {
    const message = extractErrorMessage(
      apiCallError(429, "rate_limit_error", SPEND_CAP_SENTENCE),
    );

    expect(message).toContain(SPEND_CAP_SENTENCE);
  });

  test("a genuine per-minute limit still gets the retry advice", () => {
    const message = extractErrorMessage(
      apiCallError(
        429,
        "rate_limit_error",
        "Number of request tokens has exceeded your per-minute rate limit. Please try again later.",
      ),
    );

    expect(message).toBe("Rate limit exceeded. Please wait a moment and try again.");
  });

  test("a spend cap delivered as 400 now names the reset, not just the limit", () => {
    // 400 was already caught, but by generic usage-limit copy that named
    // neither the remedy nor when access returns.
    const message = extractErrorMessage(
      apiCallError(400, "invalid_request_error", SPEND_CAP_SENTENCE),
    );

    expect(message).toContain("spend limit");
    expect(message).toContain("Oct 1, 2026");
  });

  test("an empty credit balance routes to billing, not to the cap", () => {
    const message = extractErrorMessage(
      apiCallError(
        400,
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API.",
      ),
    );

    expect(message).toContain("credit balance is empty");
    expect(message).toContain("Add credits");
  });

  test("overload handling is untouched", () => {
    const message = extractErrorMessage(
      apiCallError(529, "overloaded_error", "Overloaded"),
    );

    expect(message).toContain("temporarily overloaded");
  });
});

describe("the same guarantee through a RetryError wrapper", () => {
  test("a retried 429 spend cap is not reported as a burst limit", () => {
    const message = extractErrorMessage(
      retryError(apiCallError(429, "rate_limit_error", SPEND_CAP_SENTENCE)),
    );

    expect(message).toContain("spend limit");
    expect(message).toContain("Oct 1, 2026");
  });

  test("a retried per-minute limit keeps the retry advice", () => {
    const message = extractErrorMessage(
      retryError(
        apiCallError(
          429,
          "rate_limit_error",
          "This request would exceed your organization's requests per minute rate limit.",
        ),
      ),
    );

    expect(message).toBe("Rate limit exceeded. Please wait a moment and try again.");
  });
});

describe("401 diagnostics", () => {
  test("a plain 401 still tells the user to check the key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const message = extractErrorMessage(
      apiCallError(401, "authentication_error", "invalid x-api-key"),
    );

    expect(message).toBe("Invalid API key. Please check your API key in Settings.");
  });

  test("a 401 records the host and the provider's wording", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    extractErrorMessage(
      apiCallError(401, "authentication_error", "invalid x-api-key"),
    );

    const logged = warn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).toContain("api.anthropic.com");
    expect(logged).toContain("authentication_error");
    expect(logged).toContain("invalid x-api-key");
  });

  test("a 401 whose body reports a spent allowance is reported as that", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // The sentence outranks the status: sending the user to re-create a key
    // cannot fix a limit, and re-creating one is exactly what they would do.
    const message = extractErrorMessage(
      apiCallError(401, "authentication_error", SPEND_CAP_SENTENCE),
    );

    expect(message).not.toContain("Invalid API key");
    expect(message).toContain("spend limit");
  });
});
