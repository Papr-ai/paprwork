/**
 * Recovering the provider's message instead of reporting a bare status.
 *
 * The fixtures here are the real shapes taken from a captured failure: an
 * Anthropic spend cap arriving as `400 invalid_request_error` with an empty
 * `message` and the whole explanation sitting in `responseBody`/`data`.
 */

import { describe, expect, it } from "vitest";
import {
  describeUsageLimitError,
  extractProviderErrorPayload,
  formatProviderErrorPayload,
  isNoOutputGeneratedError,
  isUsageLimitError,
  providerFromRequestUrl,
} from "../src/gateway/services/agent/providerErrorMessage.js";

const LIMIT_MESSAGE =
  "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.";

/** The captured error, verbatim in shape: empty message, populated body. */
function anthropicLimitError(): Record<string, unknown> {
  return {
    name: "AI_APICallError",
    message: "",
    statusCode: 400,
    url: "https://api.anthropic.com/v1/messages",
    responseBody: JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: LIMIT_MESSAGE },
      request_id: "req_011CepmdjULh5K27wfxC8u1j",
    }),
    data: {
      type: "error",
      error: { type: "invalid_request_error", message: LIMIT_MESSAGE },
    },
    isRetryable: false,
  };
}

describe("extractProviderErrorPayload", () => {
  it("recovers the message the SDK left empty", () => {
    const payload = extractProviderErrorPayload(anthropicLimitError());
    expect(payload).toEqual({
      type: "invalid_request_error",
      message: LIMIT_MESSAGE,
    });
  });

  it("reads responseBody when data is absent", () => {
    const error = anthropicLimitError();
    delete error.data;
    expect(extractProviderErrorPayload(error)?.message).toBe(LIMIT_MESSAGE);
  });

  it("reads data when responseBody is absent", () => {
    const error = anthropicLimitError();
    delete error.responseBody;
    expect(extractProviderErrorPayload(error)?.message).toBe(LIMIT_MESSAGE);
  });

  it("returns undefined rather than throwing on a non-JSON body", () => {
    expect(
      extractProviderErrorPayload({ responseBody: "<html>nope</html>" }),
    ).toBeUndefined();
  });

  it("treats a blank provider message as absent", () => {
    // An empty string is not something worth showing a user, and letting it
    // through is how "API error (400): " happened in the first place.
    expect(
      extractProviderErrorPayload({
        responseBody: JSON.stringify({ error: { message: "   " } }),
      }),
    ).toBeUndefined();
  });

  it("ignores shapes with no error member", () => {
    expect(extractProviderErrorPayload({ responseBody: "{}" })).toBeUndefined();
    expect(extractProviderErrorPayload(null)).toBeUndefined();
    expect(extractProviderErrorPayload("a string")).toBeUndefined();
  });
});

describe("isUsageLimitError", () => {
  it("recognises an exhausted usage limit", () => {
    expect(isUsageLimitError({ message: LIMIT_MESSAGE })).toBe(true);
  });

  it("recognises the other ways providers word a cap", () => {
    expect(isUsageLimitError({ message: "Spend limit reached" })).toBe(true);
    expect(isUsageLimitError({ message: "Monthly spending limit hit" })).toBe(
      true,
    );
    expect(isUsageLimitError({ message: "Quota exceeded for this model" })).toBe(
      true,
    );
  });

  it("leaves a low credit balance to the existing 402 message", () => {
    // Adding credits and raising a cap are different actions, so this must not
    // be swallowed by the cap branch.
    expect(
      isUsageLimitError({ message: "Your credit balance is too low" }),
    ).toBe(false);
  });

  it("does not fire on unrelated failures", () => {
    expect(isUsageLimitError({ message: "Overloaded" })).toBe(false);
    expect(isUsageLimitError({ message: "invalid x-api-key" })).toBe(false);
    expect(isUsageLimitError({})).toBe(false);
  });
});

describe("describeUsageLimitError", () => {
  it("says what happened, when it lifts, and where to fix it", () => {
    const described = describeUsageLimitError(
      { type: "invalid_request_error", message: LIMIT_MESSAGE },
      "anthropic",
    );

    expect(described).toContain("reached your API usage limit");
    expect(described).toContain("2026-10-01 at 00:00 UTC");
    expect(described).toContain("console.anthropic.com/settings/limits");
    // Something the user can do right now, without leaving the app.
    expect(described).toContain("switch to a different model");
  });

  it("still explains itself for a provider we cannot link", () => {
    const described = describeUsageLimitError(
      { message: "Quota exceeded" },
      undefined,
    );
    expect(described).toContain("reached your API usage limit");
    expect(described).not.toContain("http");
  });

  it("omits the date when the provider did not give one", () => {
    const described = describeUsageLimitError(
      { message: "Usage limit reached." },
      "anthropic",
    );
    expect(described).not.toContain("Access returns on");
  });

  it("returns null for anything that is not a limit", () => {
    expect(describeUsageLimitError({ message: "Overloaded" })).toBeNull();
  });
});

describe("providerFromRequestUrl", () => {
  it("identifies providers from the URL the request went to", () => {
    expect(providerFromRequestUrl("https://api.anthropic.com/v1/messages")).toBe(
      "anthropic",
    );
    expect(
      providerFromRequestUrl("https://api.openai.com/v1/responses"),
    ).toBe("openai");
    expect(
      providerFromRequestUrl(
        "https://generativelanguage.googleapis.com/v1beta/models",
      ),
    ).toBe("google");
  });

  it("returns undefined for an unknown or missing host", () => {
    expect(providerFromRequestUrl("http://localhost:11434/api")).toBeUndefined();
    expect(providerFromRequestUrl(undefined)).toBeUndefined();
  });
});

describe("formatProviderErrorPayload", () => {
  it("includes the status when there is one", () => {
    expect(formatProviderErrorPayload({ message: "Bad thing" }, 400)).toBe(
      "API error (400): Bad thing",
    );
  });

  it("omits the status when there is none", () => {
    expect(formatProviderErrorPayload({ message: "Bad thing" })).toBe(
      "API error: Bad thing",
    );
  });

  it("produces nothing without a message, rather than a dangling colon", () => {
    expect(
      formatProviderErrorPayload({ type: "invalid_request_error" }, 400),
    ).toBeUndefined();
  });
});

describe("isNoOutputGeneratedError", () => {
  it("recognises the SDK error by name across realms", () => {
    // Matched by name rather than instanceof/Symbol because the error crosses
    // a module realm before we see it.
    expect(isNoOutputGeneratedError({ name: "AI_NoOutputGeneratedError" })).toBe(
      true,
    );
    expect(isNoOutputGeneratedError({ name: "NoOutputGeneratedError" })).toBe(
      true,
    );
  });

  it("recognises it by message when the name is stripped", () => {
    expect(
      isNoOutputGeneratedError(
        new Error("No output generated. Check the stream for errors."),
      ),
    ).toBe(true);
  });

  it("does not swallow a real error", () => {
    expect(isNoOutputGeneratedError(new Error(LIMIT_MESSAGE))).toBe(false);
    expect(isNoOutputGeneratedError(new Error("fetch failed"))).toBe(false);
    expect(isNoOutputGeneratedError(null)).toBe(false);
  });
});
