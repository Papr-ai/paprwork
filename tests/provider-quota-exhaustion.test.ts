import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE,
  createProviderQuotaExhaustedError,
  createRateLimitExhaustedError,
  describeQuotaExhaustion,
  detectProviderQuotaExhaustion,
  isProviderRateLimitError,
  isRetryableProviderCapacityError,
} from "../src/gateway/utils/providerRateLimitRetry.js";

/**
 * The reported failure. Anthropic returns this as HTTP 429 with
 * `type: "rate_limit_error"` — structurally identical to a per-minute burst
 * limit — so only the sentence distinguishes "you are going too fast" from
 * "your month is spent". The old code read the status and retried.
 */
const SPEND_CAP_ERROR = {
  statusCode: 429,
  responseBody: JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message:
        "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
    },
  }),
};

/** An ordinary burst ceiling: clears by itself, so retrying is correct. */
const PER_MINUTE_ERROR = {
  statusCode: 429,
  message:
    "Number of request tokens has exceeded your per-minute rate limit. Please try again later.",
};

describe("detectProviderQuotaExhaustion", () => {
  it("recognizes the reported spend cap and its reset date", () => {
    const detail = detectProviderQuotaExhaustion(SPEND_CAP_ERROR);
    expect(detail?.remedy).toBe("api_spend_cap");
    expect(detail?.resetsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("keeps the provider's own sentence rather than paraphrasing it", () => {
    const detail = detectProviderQuotaExhaustion(SPEND_CAP_ERROR);
    expect(detail?.providerMessage).toContain(
      "You will regain access on 2026-10-01",
    );
  });

  it("recognizes a Claude subscription limit and its epoch reset", () => {
    // Subscription limits arrive with the reset packed after a pipe.
    const detail = detectProviderQuotaExhaustion({
      message: "Claude AI usage limit reached|1790000000",
    });
    expect(detail?.remedy).toBe("subscription_quota");
    expect(detail?.resetsAt?.toISOString()).toBe("2026-09-21T14:13:20.000Z");
  });

  it("recognizes an empty credit balance", () => {
    const detail = detectProviderQuotaExhaustion({
      message: "Your credit balance is too low to access the Anthropic API",
    });
    expect(detail?.remedy).toBe("api_credits");
  });

  it("leaves a per-minute limit alone so it still gets retried", () => {
    // The asymmetry that matters: misreading this one would delete a retry
    // that genuinely works.
    expect(detectProviderQuotaExhaustion(PER_MINUTE_ERROR)).toBeNull();
    expect(isRetryableProviderCapacityError(PER_MINUTE_ERROR)).toBe(true);
  });

  it("prefers transient when a payload carries both signals", () => {
    expect(
      detectProviderQuotaExhaustion({
        message:
          "usage limit reached: tokens per minute exceeded, please retry",
      }),
    ).toBeNull();
  });

  it("ignores a plain 429 with nothing quota-shaped in it", () => {
    expect(detectProviderQuotaExhaustion({ statusCode: 429 })).toBeNull();
    expect(detectProviderQuotaExhaustion("Too Many Requests")).toBeNull();
  });

  it("does not read an unrelated timestamp as the reset time", () => {
    // A date has to be anchored to a reset word. A confidently wrong reset time
    // is worse than admitting we do not know.
    const detail = detectProviderQuotaExhaustion({
      message:
        "credit balance is too low (account created 2020-03-04T00:00:00Z)",
    });
    expect(detail?.remedy).toBe("api_credits");
    expect(detail?.resetsAt).toBeUndefined();
  });
});

describe("isRetryableProviderCapacityError", () => {
  it("stops treating spent allowance as capacity pressure", () => {
    // It is still a rate-limit-shaped error; it is just not worth retrying.
    expect(isProviderRateLimitError(SPEND_CAP_ERROR)).toBe(true);
    expect(isRetryableProviderCapacityError(SPEND_CAP_ERROR)).toBe(false);
  });

  it("still retries overloaded servers", () => {
    expect(
      isRetryableProviderCapacityError({ message: "overloaded_error" }),
    ).toBe(true);
  });
});

describe("describeQuotaExhaustion", () => {
  it("says waiting will not help, when it clears, and what to change", () => {
    const message = describeQuotaExhaustion(
      detectProviderQuotaExhaustion(SPEND_CAP_ERROR)!,
    );
    expect(message).toContain("retrying won't help");
    expect(message).toContain("Oct 1, 2026");
    expect(message).toContain("console");
    expect(message).toContain("You will regain access on 2026-10-01");
  });

  it("omits the timing sentence when the provider gave no reset", () => {
    const message = describeQuotaExhaustion({ remedy: "api_credits" });
    expect(message).not.toContain("Access returns");
    expect(message).toContain("credit balance is empty");
  });

  it("points a subscription limit at model choice, not at billing", () => {
    const message = describeQuotaExhaustion({ remedy: "subscription_quota" });
    expect(message).toContain("subscription's usage limit");
    expect(message).toContain("model that still has quota");
  });
});

describe("error payloads", () => {
  it("tags a quota refusal with its own code so Resume can be withheld", () => {
    const error = createProviderQuotaExhaustedError({
      remedy: "api_spend_cap",
      resetsAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(error.code).toBe(PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE);
    expect(error.code).not.toBe("rate_limit_exhausted");
  });

  it("still offers Resume for a transient limit, now quoting the provider", () => {
    const error = createRateLimitExhaustedError(PER_MINUTE_ERROR);
    expect(error.code).toBe("rate_limit_exhausted");
    expect(error.message).toContain("Tap Resume");
    expect(error.message).toContain("per-minute rate limit");
  });

  it("keeps the bare Resume message when there is no useful sentence", () => {
    const error = createRateLimitExhaustedError({ statusCode: 429 });
    expect(error.message).toBe(
      "The AI provider is rate limited. Tap Resume when ready to continue.",
    );
  });
});
