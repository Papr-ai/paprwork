import { describe, expect, it } from "vitest";
import {
  classifyCredentialToken,
  createProviderQuotaExhaustedError,
  createRateLimitExhaustedError,
  describeAlternativeCredential,
  describeCredentialInUse,
  describeProviderRateLimit,
  detectProviderQuotaExhaustion,
  isRetryableProviderCapacityError,
} from "../src/gateway/utils/providerRateLimitRetry";

/**
 * Verbatim from a real failure: the user switched Claude from API key to
 * subscription login, and this is what Anthropic returned on the OAuth attempt.
 * It matched neither the quota patterns nor the transient ones, so it fell
 * through to a generic message that named no credential — leaving the switch
 * indistinguishable from having done nothing.
 */
const ACCOUNT_RATE_LIMIT = {
  statusCode: 429,
  message:
    '429 {"type":"error","error":{"type":"rate_limit_error","message":' +
    '"This request would exceed your account\'s rate limit. Please try again ' +
    'later."},"request_id":"req_011Cf28kPbBxyGXaQdJH8SwL"}',
};

/** The spend cap the same user hit on the API key, which did read clearly. */
const SPEND_CAP = {
  statusCode: 429,
  message:
    "You have reached your specified API usage limits. You will regain " +
    "access on 2026-10-01 at 00:00 UTC.",
};

describe("credential kind, read from the token", () => {
  it.each([
    ["sk-ant-oat01-" + "a".repeat(95), "oauth"],
    ["sk-ant-ort01-" + "a".repeat(95), "oauth"],
    ["sk-oat-" + "a".repeat(40), "oauth"],
    ["eyJhbGciOi.eyJzdWIiOiJ4In0.sig", "oauth"],
    ["sk-ant-api03-" + "a".repeat(95), "apiKey"],
    ["sk-proj-" + "a".repeat(40), "apiKey"],
  ])("reads %s… as %s", (token, expected) => {
    expect(classifyCredentialToken(token)).toBe(expected);
  });

  it.each([undefined, "", "   "])("says nothing for %p", (token) => {
    expect(classifyCredentialToken(token)).toBe("unknown");
  });

  it("prefers the OAuth shape over the sk- key rule they both match", () => {
    // `sk-oat…` also starts with `sk-`; ordering is the only thing keeping an
    // OAuth token from being reported as an API key.
    expect(classifyCredentialToken("sk-oat-abc")).toBe("oauth");
  });
});

describe("naming the credential", () => {
  it("names Claude's two credentials distinctly", () => {
    const oauth = { provider: "anthropic", kind: "oauth" as const };
    const apiKey = { provider: "anthropic", kind: "apiKey" as const };
    expect(describeCredentialInUse(oauth)).toBe("your Claude subscription login");
    expect(describeCredentialInUse(apiKey)).toBe("your Anthropic API key");
  });

  it("points at the other credential, which is the switch the user is making", () => {
    expect(
      describeAlternativeCredential({ provider: "anthropic", kind: "oauth" }),
    ).toBe("your Anthropic API key");
    expect(
      describeAlternativeCredential({ provider: "anthropic", kind: "apiKey" }),
    ).toBe("your Claude subscription login");
  });

  it("stays generic rather than guessing a provider it was not told", () => {
    expect(describeCredentialInUse({ kind: "oauth" })).toBe(
      "your subscription login",
    );
  });

  it("says nothing when the token said nothing", () => {
    expect(describeCredentialInUse({ kind: "unknown" })).toBeUndefined();
    expect(describeCredentialInUse(undefined)).toBeUndefined();
  });
});

describe("Anthropic's account rate limit", () => {
  it("is a capacity ceiling, not spent allowance", () => {
    // One word from the subscription-quota phrasing ("account's *usage*
    // limit"), so this is the pattern most at risk of being reclassified.
    expect(detectProviderQuotaExhaustion(ACCOUNT_RATE_LIMIT)).toBeNull();
    expect(isRetryableProviderCapacityError(ACCOUNT_RATE_LIMIT)).toBe(true);
  });

  it("still keeps a genuine spend cap out of the retry path", () => {
    expect(detectProviderQuotaExhaustion(SPEND_CAP)?.remedy).toBe(
      "api_spend_cap",
    );
    expect(isRetryableProviderCapacityError(SPEND_CAP)).toBe(false);
  });
});

describe("the message a user reads after switching auth mode", () => {
  const onOAuth = createRateLimitExhaustedError(ACCOUNT_RATE_LIMIT, {
    provider: "anthropic",
    kind: "oauth",
  }).message;
  const onApiKey = createRateLimitExhaustedError(ACCOUNT_RATE_LIMIT, {
    provider: "anthropic",
    kind: "apiKey",
  }).message;

  it("reads differently on each credential — the whole point of the fix", () => {
    // Before, both produced the same sentence, so a user who switched had no
    // way to tell whether the switch had reached the request.
    expect(onOAuth).not.toBe(onApiKey);
    expect(onOAuth).toContain("your Claude subscription login");
    expect(onApiKey).toContain("your Anthropic API key");
  });

  it("names the credential that was refused, not the one to try next", () => {
    expect(onOAuth.indexOf("your Claude subscription login")).toBeLessThan(
      onOAuth.indexOf("your Anthropic API key"),
    );
  });

  it("quotes the provider instead of swallowing its explanation", () => {
    expect(onOAuth).toContain(
      "This request would exceed your account's rate limit",
    );
  });

  it("offers the other credential as a way out", () => {
    expect(onOAuth).toContain("Settings → AI Models");
    expect(onOAuth).toContain("your Anthropic API key");
  });

  it("keeps the bare message when the token identified nothing", () => {
    // Unattributed is still the honest output for an unrecognised token; this
    // pins that adding attribution did not change the fallback.
    expect(createRateLimitExhaustedError({ statusCode: 429 }).message).toBe(
      "The AI provider is rate limited. Tap Resume when ready to continue.",
    );
  });
});

describe("Resume is only promised where the button exists", () => {
  it("offers Resume on the route that renders one", () => {
    expect(
      createRateLimitExhaustedError(ACCOUNT_RATE_LIMIT, {
        provider: "anthropic",
        kind: "oauth",
      }).message,
    ).toContain("Tap Resume");
  });

  it("does not name Resume on the route that has no such control", () => {
    // The AI SDK path surfaces a plain error with no Resume affordance;
    // telling the user to tap one would point at a control not on screen.
    const message = describeProviderRateLimit(
      ACCOUNT_RATE_LIMIT,
      { provider: "anthropic", kind: "apiKey" },
      { resumable: false },
    );
    expect(message).not.toContain("Resume");
    expect(message).toContain("Wait a moment and try again");
    expect(message).toContain("your Anthropic API key");
  });
});

describe("spent allowance also says which credential it was spent on", () => {
  it("attributes a spend cap to the API key", () => {
    const detail = detectProviderQuotaExhaustion(SPEND_CAP);
    expect(detail).not.toBeNull();
    const message = createProviderQuotaExhaustedError(detail!, {
      provider: "anthropic",
      kind: "apiKey",
    }).message;
    expect(message).toContain("Your Anthropic API key has reached its spend limit");
    expect(message).toContain("Access returns");
  });

  it("attributes a subscription quota to the subscription login", () => {
    const detail = detectProviderQuotaExhaustion({
      message: "usage limit reached|1790000000",
    });
    expect(detail).not.toBeNull();
    expect(
      createProviderQuotaExhaustedError(detail!, {
        provider: "anthropic",
        kind: "oauth",
      }).message,
    ).toContain("Your Claude subscription login has reached its usage limit");
  });

  it("falls back to the unattributed headline with no credential", () => {
    const detail = detectProviderQuotaExhaustion(SPEND_CAP);
    expect(createProviderQuotaExhaustedError(detail!).message).toContain(
      "Your API spend limit is reached",
    );
  });
});

describe("quoting the provider", () => {
  it("quotes the sentence inside a flattened body, not the body", () => {
    // pi-ai hands us the whole response as `429 {…}`, so the sentence is only
    // reachable by parsing from the first brace.
    const message = describeProviderRateLimit(
      ACCOUNT_RATE_LIMIT,
      { provider: "anthropic", kind: "oauth" },
      { resumable: true },
    );
    expect(message).toContain(
      "Provider said: \u201cThis request would exceed your account's rate limit. Please try again later.\u201d",
    );
    expect(message).not.toContain('{"type":"error"');
    expect(message).not.toContain("request_id");
  });

  it("quotes the body when the provider gave no prose", () => {
    // Better than quoting nothing: a serialized body is demoted, not dropped.
    const message = describeProviderRateLimit(
      {
        statusCode: 429,
        message: '{"a":"bb","c":{"d":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}',
      },
      { provider: "anthropic", kind: "apiKey" },
      { resumable: false },
    );
    expect(message).toContain('Provider said: \u201c{"a":"bb"');
  });

  it("still classifies a spend cap reported through a flattened body", () => {
    const detail = detectProviderQuotaExhaustion({
      statusCode: 429,
      message:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}',
    });
    expect(detail?.remedy).toBe("api_spend_cap");
    expect(detail?.providerMessage).toContain("specified API usage limits");
  });
});
