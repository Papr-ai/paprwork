import { afterEach, describe, expect, it, vi } from "vitest";

let epoch = 0;
vi.mock("../../src/gateway/utils/keyResolver.js", () => ({ getAuthEpoch: () => epoch }));

import {
  autoRefusedProviders,
  isProviderAuthError,
  markAutoProviderRefused,
} from "../../src/gateway/utils/autoProviderHealth.js";

describe("Auto provider health", () => {
  afterEach(() => {
    epoch += 1;
  });

  it("recognises a provider refusing the credential (dev proxy's dead Anthropic key)", () => {
    const proxied =
      'API error (500): Type validation failed: Value: {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"authentication_error\\",\\"message\\":\\"invalid x-api-key\\"}}"}}';
    expect(isProviderAuthError(proxied)).toBe(true);
    expect(isProviderAuthError("401 Unauthorized")).toBe(true);
    expect(isProviderAuthError("API key not valid. Please pass a valid API key.")).toBe(true);
  });

  it("does not treat quota, rate limits or outages as auth refusals", () => {
    expect(isProviderAuthError("429 rate_limit_error: slow down")).toBe(false);
    expect(isProviderAuthError("Your credit balance is too low")).toBe(false);
    expect(isProviderAuthError("529 overloaded_error")).toBe(false);
    expect(isProviderAuthError("500 internal server error")).toBe(false);
  });

  it("remembers refused providers until credentials change", () => {
    markAutoProviderRefused("anthropic");
    markAutoProviderRefused("openai-codex");
    expect(autoRefusedProviders().sort()).toEqual(["anthropic", "openai"]);
    epoch += 1; // user signs in / changes a key
    expect(autoRefusedProviders()).toEqual([]);
  });
});
