import { describe, it, expect, beforeEach } from "vitest";
import {
  isProviderAuthRejection,
  providerForModelId,
} from "../ui/utils/providerAuthRejection";
import { useProviderAuthStore } from "../ui/stores/providerAuthStore";

describe("isProviderAuthRejection", () => {
  it("matches the message the gateway rewrites a 401 into", () => {
    expect(
      isProviderAuthRejection(
        "Invalid API key. Please check your API key in Settings.",
      ),
    ).toBe(true);
  });

  it("matches the raw Anthropic OAuth body seen in the failing turn", () => {
    expect(
      isProviderAuthRejection(
        '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."},"request_id":null}',
      ),
    ).toBe(true);
  });

  it("matches an Anthropic API-key rejection", () => {
    expect(isProviderAuthRejection("invalid x-api-key")).toBe(true);
  });

  it("does not treat a spent allowance as a bad key", () => {
    expect(
      isProviderAuthRejection(
        "Your API spend limit is reached — retrying won't help until it resets.",
      ),
    ).toBe(false);
    expect(
      isProviderAuthRejection(
        'authentication_error: You have reached your specified API usage limits.',
      ),
    ).toBe(false);
  });

  it("ignores failures that are not about credentials", () => {
    // Misreading any of these as an auth failure would tell the user to
    // reconnect a connection that is fine.
    expect(isProviderAuthRejection("Rate limit exceeded (429)")).toBe(false);
    expect(isProviderAuthRejection("Overloaded (529)")).toBe(false);
    expect(
      isProviderAuthRejection("AI_TypeValidationError: invalid_union"),
    ).toBe(false);
    expect(isProviderAuthRejection("Context limit approaching")).toBe(false);
  });
});

describe("providerForModelId", () => {
  it("attributes the model from the failing turn to Anthropic", () => {
    expect(providerForModelId("claude-opus-5")).toBe("anthropic");
  });

  it("returns undefined rather than guessing for an unknown model", () => {
    // An unattributed rejection must not tint an unrelated provider's card.
    expect(providerForModelId("some-model-we-do-not-ship")).toBeUndefined();
    expect(providerForModelId(undefined)).toBeUndefined();
  });
});

describe("useProviderAuthStore", () => {
  beforeEach(() => {
    useProviderAuthStore.setState({ rejections: {} });
  });

  it("holds no rejection until one is observed", () => {
    expect(
      useProviderAuthStore.getState().rejections.anthropic,
    ).toBeUndefined();
  });

  it("records a rejection against one provider only", () => {
    useProviderAuthStore
      .getState()
      .recordRejection("anthropic", "Invalid API key.");

    const { rejections } = useProviderAuthStore.getState();
    expect(rejections.anthropic?.message).toBe("Invalid API key.");
    expect(rejections.openai).toBeUndefined();
  });

  it("clears on remediation", () => {
    const store = useProviderAuthStore.getState();
    store.recordRejection("anthropic", "Invalid API key.");
    store.clearRejection("anthropic");

    expect(
      useProviderAuthStore.getState().rejections.anthropic,
    ).toBeUndefined();
  });

  it("keeps the same state object when clearing something not recorded", () => {
    // Guards against a no-op clear (every successful turn calls it) forcing a
    // re-render of the Settings card.
    const before = useProviderAuthStore.getState().rejections;
    useProviderAuthStore.getState().clearRejection("openai");

    expect(useProviderAuthStore.getState().rejections).toBe(before);
  });
});
