import { describe, expect, it } from "vitest";
import { normalizePortableJobPrompt } from "../src/gateway/services/jobs/normalizePortableJobPrompt.js";
import {
  MAX_PROVIDER_RATE_LIMIT_RETRIES,
  RATE_LIMIT_EXHAUSTED_ERROR_CODE,
  computeRateLimitBackoffMs,
  createRateLimitExhaustedError,
  isProviderRateLimitError,
  isRetryableProviderCapacityError,
} from "../src/gateway/utils/providerRateLimitRetry.js";

describe("normalizePortableJobPrompt", () => {
  it("rewrites tilde Papr job paths to PAPR_HOME", () => {
    const normalized = normalizePortableJobPrompt(
      "for db in ~/Papr/jobs/*/data/data.db; do echo $db; done",
    );
    expect(normalized).toContain("$PAPR_HOME/Jobs/");
    expect(normalized).not.toContain("~/Papr/jobs/");
  });
});

describe("providerRateLimitRetry", () => {
  it("detects Anthropic rate_limit_error payloads", () => {
    expect(
      isProviderRateLimitError({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      }),
    ).toBe(true);
  });

  it("treats overload as retryable capacity errors", () => {
    expect(
      isRetryableProviderCapacityError({
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ).toBe(true);
  });

  it("honors retry-after when present", () => {
    const waitMs = computeRateLimitBackoffMs(0, { retryAfter: 7 });
    expect(waitMs).toBe(7000);
  });

  it("caps automatic retries at two before resume UI", () => {
    expect(MAX_PROVIDER_RATE_LIMIT_RETRIES).toBe(2);
  });

  it("creates a resumable rate-limit exhausted error", () => {
    const error = createRateLimitExhaustedError();
    expect(error.code).toBe(RATE_LIMIT_EXHAUSTED_ERROR_CODE);
    expect(error.type).toBe("stream_pause");
  });
});
