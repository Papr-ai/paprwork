import { afterEach, describe, expect, it, vi } from "vitest";

// Agent jobs on ChatGPT sign-in: a model ChatGPT does not serve must never be
// sent down the Platform API route with the sign-in token ("Invalid API key").

let epoch = 0;
vi.mock("../../src/gateway/utils/keyResolver.js", () => ({
  getApiKeys: vi.fn(),
  getAuthEpoch: () => epoch,
}));
vi.mock("../../src/gateway/utils/reachableProvider.js", () => ({
  findReachableProvider: vi.fn(),
  REACHABLE_PROVIDER_ORDER: ["anthropic", "openai", "google"],
}));

import { getApiKeys } from "../../src/gateway/utils/keyResolver.js";
import { findReachableProvider } from "../../src/gateway/utils/reachableProvider.js";
import {
  CHATGPT_SIGN_IN_FALLBACK_MODEL,
  keepOAuthOnSupportedModel,
  resolveAuthRefusalRetry,
} from "../../src/gateway/utils/resolveJobSessionAuth.js";

const chatgpt = (model: string) => ({
  provider: "openai" as const,
  model,
  apiKey: "chatgpt-oauth-token",
  authType: "oauth" as const,
});

describe("keepOAuthOnSupportedModel", () => {
  afterEach(() => {
    vi.resetAllMocks();
    epoch += 1;
  });

  it("moves gpt-5.4-mini on ChatGPT sign-in to Luna when there is no API key", async () => {
    vi.mocked(getApiKeys).mockResolvedValue({});
    const out = await keepOAuthOnSupportedModel(chatgpt("gpt-5.4-mini"));
    expect(out).toMatchObject({
      provider: "openai",
      model: CHATGPT_SIGN_IN_FALLBACK_MODEL,
      authType: "oauth",
      apiKey: "chatgpt-oauth-token",
    });
  });

  it("keeps the model and uses the Platform key when one exists", async () => {
    vi.mocked(getApiKeys).mockResolvedValue({ OPENAI_API_KEY: "sk-proj-real" });
    const out = await keepOAuthOnSupportedModel(chatgpt("gpt-5.4-mini"));
    expect(out).toMatchObject({ model: "gpt-5.4-mini", authType: "apiKey", apiKey: "sk-proj-real" });
  });

  it("leaves models ChatGPT serves alone", async () => {
    for (const model of ["gpt-5-6-luna", "gpt-5-6-sol", "gpt-5.5", "gpt-6-astra"]) {
      expect(await keepOAuthOnSupportedModel(chatgpt(model))).toEqual(chatgpt(model));
    }
    expect(getApiKeys).not.toHaveBeenCalled();
  });

  it("leaves API keys, the Papr proxy and other providers alone", async () => {
    const apiKey = { ...chatgpt("gpt-5.4-mini"), authType: "apiKey" as const };
    expect(await keepOAuthOnSupportedModel(apiKey)).toEqual(apiKey);
    const proxy = { ...chatgpt("gpt-5.4-mini"), usePaprProxy: true };
    expect(await keepOAuthOnSupportedModel(proxy)).toEqual(proxy);
    const claude = { provider: "anthropic" as const, model: "claude-haiku-4-5", apiKey: "t", authType: "oauth" as const };
    expect(await keepOAuthOnSupportedModel(claude)).toEqual(claude);
  });
});

describe("resolveAuthRefusalRetry", () => {
  afterEach(() => {
    vi.resetAllMocks();
    epoch += 1;
  });

  it("moves to the next reachable provider and skips the one that refused", async () => {
    vi.mocked(findReachableProvider).mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      creds: { apiKey: "claude-oauth", authType: "oauth" },
    });
    const next = await resolveAuthRefusalRetry("openai");
    expect(next).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "claude-oauth" });
    expect(vi.mocked(findReachableProvider).mock.calls[0]?.[0]).toEqual(["openai"]);
  });

  it("returns null when no other provider is reachable", async () => {
    vi.mocked(findReachableProvider).mockResolvedValue(null);
    expect(await resolveAuthRefusalRetry("anthropic")).toBeNull();
  });
});
