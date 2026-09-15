import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  EXPLORATION_ANTHROPIC_MODEL,
  EXPLORATION_GOOGLE_MODEL,
  EXPLORATION_OPENAI_API_KEY_MODEL,
  EXPLORATION_OPENAI_OAUTH_MODEL,
  resolveCodebaseExplorerProviderModel,
} from "../src/gateway/utils/explorationSubAgentModel.js";

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getProviderAuth: vi.fn(),
  getApiKeys: vi.fn(),
}));

vi.mock("../src/gateway/utils/defaultProvider.js", () => ({
  getDefaultProviderAndModel: vi.fn(),
}));

import { getApiKeys, getProviderAuth } from "../src/gateway/utils/keyResolver.js";
import { getDefaultProviderAndModel } from "../src/gateway/utils/defaultProvider.js";

describe("resolveCodebaseExplorerProviderModel", () => {
  beforeEach(() => {
    vi.mocked(getProviderAuth).mockReset();
    vi.mocked(getApiKeys).mockReset();
    vi.mocked(getDefaultProviderAndModel).mockReset();
  });

  test("prefers Anthropic Haiku when Claude OAuth or API key is available", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (provider) => {
      if (provider === "anthropic") {
        return { type: "oauth", token: "anthropic-oauth" };
      }
      return null;
    });

    const result = await resolveCodebaseExplorerProviderModel();
    expect(result).toEqual({
      provider: "anthropic",
      model: EXPLORATION_ANTHROPIC_MODEL,
    });
  });

  test("uses GPT Luna on ChatGPT OAuth", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (provider) => {
      if (provider === "openai") {
        return { type: "oauth", token: "openai-oauth" };
      }
      return null;
    });

    const result = await resolveCodebaseExplorerProviderModel();
    expect(result).toEqual({
      provider: "openai",
      model: EXPLORATION_OPENAI_OAUTH_MODEL,
    });
  });

  test("uses gpt-5.4-mini on OpenAI Platform API key", async () => {
    vi.mocked(getProviderAuth).mockImplementation(async (provider) => {
      if (provider === "openai") {
        return { type: "apiKey", key: "sk-proj-test" };
      }
      return null;
    });

    const result = await resolveCodebaseExplorerProviderModel();
    expect(result).toEqual({
      provider: "openai",
      model: EXPLORATION_OPENAI_API_KEY_MODEL,
    });
  });

  test("falls back to Google when only Gemini key is configured", async () => {
    vi.mocked(getProviderAuth).mockResolvedValue(null);
    vi.mocked(getApiKeys).mockResolvedValue({
      GOOGLE_API_KEY: "google-key",
    });

    const result = await resolveCodebaseExplorerProviderModel();
    expect(result).toEqual({
      provider: "google",
      model: EXPLORATION_GOOGLE_MODEL,
    });
  });
});
