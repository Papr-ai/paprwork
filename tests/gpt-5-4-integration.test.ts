/**
 * GPT-5.4 Legacy Integration Tests
 * Verify GPT-5.4 mini and legacy ID normalization still work after GPT-5.6 launch
 */

import { describe, it, expect } from "vitest";
import { CHAT_MODELS, getModelById } from "../ui/constants/models.js";
import { MODEL_PRICING, calculateCost } from "../src/gateway/services/CostCalculation.js";
import {
  normalizeOpenAIModelId,
  isOpenAICodexModel,
  requiresOpenAIPlatformApiKey,
} from "../src/gateway/utils/modelNormalizer.js";

describe("GPT-5.4 mini Model Definitions", () => {
  it("should include GPT-5.4 mini in CHAT_MODELS", () => {
    const gpt54Mini = getModelById("gpt-5.4-mini");
    expect(gpt54Mini).toBeDefined();
    expect(gpt54Mini?.id).toBe("gpt-5.4-mini");
    expect(gpt54Mini?.name).toBe("GPT-5.4 mini");
    expect(gpt54Mini?.provider).toBe("openai");
    expect(gpt54Mini?.group).toBe("OpenAI");
  });

  it("should not expose removed gpt-5.4 flagship picker ids", () => {
    expect(getModelById("gpt-5.4")).toBeUndefined();
    expect(getModelById("gpt-5.4-pro")).toBeUndefined();
    expect(getModelById("gpt-5.4-high")).toBeUndefined();
  });

  it("should configure GPT-5.4 mini with correct capabilities", () => {
    const gpt54Mini = getModelById("gpt-5.4-mini");
    expect(gpt54Mini?.supportsThinking).toBe(true);
    expect(gpt54Mini?.maxTokens).toBe(128000);
    expect(gpt54Mini?.reasoning?.effort).toBe("medium");
    expect(gpt54Mini?.requiresApiKey).toBe("OPENAI_API_KEY");
  });
});

describe("GPT-5.4 Legacy Cost Calculation", () => {
  it("should keep legacy gpt-5.4 pricing entries for old chat logs", () => {
    const pricing = MODEL_PRICING["gpt-5.4"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(5.0);
    expect(pricing.output).toBe(30.0);
  });

  it("should have correct pricing for GPT-5.4 mini", () => {
    const pricing = MODEL_PRICING["gpt-5.4-mini"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(0.75);
    expect(pricing.output).toBe(4.5);
  });

  it("should show GPT-5.4 mini is cheaper than legacy gpt-5.4 label for same usage", () => {
    const costMini = calculateCost("gpt-5.4-mini", 100_000, 50_000);
    const costLegacy = calculateCost("gpt-5.4", 100_000, 50_000);
    expect(costMini).toBeLessThan(costLegacy);
  });
});

describe("GPT-5.4 Legacy Model Normalization", () => {
  it("should map legacy gpt-5.4 ids to gpt-5.6-sol API id", () => {
    expect(normalizeOpenAIModelId("gpt-5.4")).toBe("gpt-5.6-sol");
    expect(normalizeOpenAIModelId("gpt-5.4-pro")).toBe("gpt-5.6-sol");
    expect(normalizeOpenAIModelId("gpt-5-4-high")).toBe("gpt-5.6-sol");
  });

  it("should keep gpt-5.4-mini as distinct API id", () => {
    expect(normalizeOpenAIModelId("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("should recognize legacy GPT-5.4 as OpenAI Codex compatible (OAuth)", () => {
    expect(isOpenAICodexModel("gpt-5.4")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.4-mini")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.4-pro")).toBe(true);
  });
});

describe("GPT-5.4 model lineup", () => {
  it("should include GPT-5.4 mini in OpenAI model group", () => {
    const openAIModels = CHAT_MODELS.filter((m) => m.group === "OpenAI");
    const modelIds = openAIModels.map((m) => m.id);

    expect(modelIds).toContain("gpt-5.4-mini");
    expect(modelIds).toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.4");
    expect(modelIds).not.toContain("gpt-5.4-pro");
    expect(modelIds).not.toContain("gpt-5.2");
  });
});

describe("GPT-5.4 Legacy Edge Cases", () => {
  it("should map legacy GPT-5.2 picker ids to GPT-5.6 Sol API id", () => {
    expect(normalizeOpenAIModelId("gpt-5.2")).toBe("gpt-5.6-sol");
    expect(normalizeOpenAIModelId("gpt-5.2-low")).toBe("gpt-5.6-sol");
  });

  it("should require Platform API key for retired gpt-5.3-codex on ChatGPT OAuth", () => {
    expect(requiresOpenAIPlatformApiKey("gpt-5.3-codex")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.3-codex")).toBe(false);
    expect(getModelById("gpt-5.3-codex")?.requiresApiKey).toBe(
      "OPENAI_API_KEY",
    );
  });
});
