import { describe, expect, it } from "vitest";
import { CHAT_MODELS } from "../ui/constants/models";
import type { AuthStatus } from "../ui/hooks/useAuthStatus";
import {
  CURATED_MODEL_PRIORITY,
  GLOBAL_INITIAL_DEFAULT_MODEL_ID,
  filterAccessibleModels,
  resolveAuthAwareDefaultModelIds,
  resolveGlobalDefaultForAuth,
} from "../ui/utils/authAwareModelDefaults";

const emptyStatus: AuthStatus = {
  openai: { oauth: false, apiKey: false },
  anthropic: { oauth: false, apiKey: false },
  google: { apiKey: false },
  paprProxy: false,
};

describe("resolveAuthAwareDefaultModelIds", () => {
  it("uses curated sonnet → gpt → gemini order when OAuth is connected", () => {
    const ids = resolveAuthAwareDefaultModelIds({
      ...emptyStatus,
      anthropic: { oauth: true, apiKey: false },
    });
    expect(ids).toEqual(CURATED_MODEL_PRIORITY);
  });

  it("prefers Gemini first for Papr proxy only (no BYOK/OAuth)", () => {
    const ids = resolveAuthAwareDefaultModelIds({
      ...emptyStatus,
      paprProxy: true,
    });
    expect(ids[0]).toBe(GLOBAL_INITIAL_DEFAULT_MODEL_ID);
  });

  it("uses curated order when Papr proxy is combined with OAuth", () => {
    const ids = resolveAuthAwareDefaultModelIds({
      ...emptyStatus,
      paprProxy: true,
      openai: { oauth: true, apiKey: false },
    });
    expect(ids).toEqual(CURATED_MODEL_PRIORITY);
  });

  it("falls back to local Ollama when no cloud auth is configured", () => {
    const ids = resolveAuthAwareDefaultModelIds(emptyStatus);
    expect(ids[0]).toBe("qwen3.5:9b-q4_k_m");
  });
});

describe("resolveGlobalDefaultForAuth", () => {
  it("prefers Sonnet when Claude OAuth or API key is present", () => {
    expect(
      resolveGlobalDefaultForAuth({
        ...emptyStatus,
        anthropic: { oauth: true, apiKey: false },
      }),
    ).toBe("claude-sonnet-5");
  });

  it("prefers GPT when only OpenAI auth is present", () => {
    expect(
      resolveGlobalDefaultForAuth({
        ...emptyStatus,
        openai: { oauth: true, apiKey: false },
      }),
    ).toBe("gpt-5-6-sol");
  });

  it("prefers Sonnet when both OAuth providers are connected", () => {
    expect(
      resolveGlobalDefaultForAuth({
        ...emptyStatus,
        anthropic: { oauth: true, apiKey: false },
        openai: { oauth: true, apiKey: false },
      }),
    ).toBe("claude-sonnet-5");
  });

  it("falls back to Gemini for Papr proxy only", () => {
    expect(
      resolveGlobalDefaultForAuth({
        ...emptyStatus,
        paprProxy: true,
      }),
    ).toBe(GLOBAL_INITIAL_DEFAULT_MODEL_ID);
  });

  it("falls back to Gemini after Claude disconnect when Papr remains", () => {
    expect(
      resolveGlobalDefaultForAuth({
        ...emptyStatus,
        paprProxy: true,
        openai: { oauth: false, apiKey: false },
        anthropic: { oauth: false, apiKey: false },
      }),
    ).toBe(GLOBAL_INITIAL_DEFAULT_MODEL_ID);
  });

  it("falls back to Ollama when no cloud auth remains", () => {
    expect(resolveGlobalDefaultForAuth(emptyStatus)).toBe("qwen3.5:9b-q4_k_m");
  });
});

describe("filterAccessibleModels", () => {
  it("keeps only models matching auth", () => {
    const anthropicOnly = CHAT_MODELS.filter(
      (model) => model.provider === "anthropic",
    ).slice(0, 2);
    const openAiOnly = CHAT_MODELS.filter(
      (model) => model.provider === "openai",
    ).slice(0, 2);
    const models = [...anthropicOnly, ...openAiOnly];

    const filtered = filterAccessibleModels(models, (model) =>
      model.provider === "anthropic",
    );

    expect(filtered.every((model) => model.provider === "anthropic")).toBe(true);
    expect(filtered).toHaveLength(anthropicOnly.length);
  });
});
