/**
 * GPT-5.4 Integration Tests
 * Verify GPT-5.4 family models are properly integrated
 */

import { describe, it, expect } from "vitest";
import { CHAT_MODELS, getModelById } from "../ui/constants/models.js";
import { MODEL_PRICING, calculateCost } from "../src/gateway/services/CostCalculation.js";
import {
  normalizeOpenAIModelId,
  isOpenAICodexModel,
  requiresOpenAIPlatformApiKey,
} from "../src/gateway/utils/modelNormalizer.js";

describe("GPT-5.4 Model Definitions", () => {
  it("should include GPT-5.4 model in CHAT_MODELS", () => {
    const gpt54 = getModelById("gpt-5.4");
    expect(gpt54).toBeDefined();
    expect(gpt54?.id).toBe("gpt-5.4");
    expect(gpt54?.name).toBe("GPT-5.4");
    expect(gpt54?.provider).toBe("openai");
    expect(gpt54?.group).toBe("OpenAI");
  });

  it("should not expose removed gpt-5.4-pro picker id", () => {
    expect(getModelById("gpt-5.4-pro")).toBeUndefined();
  });

  it("should configure GPT-5.4 and high tier with correct capabilities", () => {
    const gpt54 = getModelById("gpt-5.4");
    const gpt54High = getModelById("gpt-5.4-high");

    expect(gpt54?.supportsThinking).toBe(true);
    expect(gpt54High?.supportsThinking).toBe(true);

    expect(gpt54?.maxTokens).toBe(128000);
    expect(gpt54High?.maxTokens).toBe(128000);

    expect(gpt54?.reasoning?.effort).toBe("medium");
    expect(gpt54High?.reasoning?.effort).toBe("high");

    expect(gpt54?.requiresApiKey).toBe("OPENAI_API_KEY");
    expect(gpt54High?.requiresApiKey).toBe("OPENAI_API_KEY");
  });
});

describe("GPT-5.4 Cost Calculation", () => {
  it("should have correct pricing for GPT-5.4", () => {
    const pricing = MODEL_PRICING["gpt-5.4"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(2.5);
    expect(pricing.output).toBe(15.0);
  });

  it("should treat legacy gpt-5.4-pro id at GPT-5.4 tier for cost", () => {
    const pricing = MODEL_PRICING["gpt-5.4-pro"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(2.5);
    expect(pricing.output).toBe(15.0);
  });

  it("should calculate cost correctly for GPT-5.4", () => {
    const cost = calculateCost("gpt-5.4", 10_000, 5_000);
    expect(cost).toBeCloseTo(0.1, 4);
  });

  it("should calculate same tier cost for legacy gpt-5.4-pro label", () => {
    const cost54 = calculateCost("gpt-5.4", 10_000, 5_000);
    const costLegacy = calculateCost("gpt-5.4-pro", 10_000, 5_000);
    expect(costLegacy).toBeCloseTo(cost54, 6);
  });
});

describe("GPT-5.4 Model Normalization", () => {
  it("should normalize gpt-5.4 correctly", () => {
    expect(normalizeOpenAIModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("should map legacy gpt-5.4-pro to gpt-5.4 API id", () => {
    expect(normalizeOpenAIModelId("gpt-5.4-pro")).toBe("gpt-5.4");
  });

  it("should recognize GPT-5.4 as OpenAI Codex compatible (OAuth)", () => {
    expect(isOpenAICodexModel("gpt-5.4")).toBe(true);
  });

  it("should recognize legacy gpt-5.4-pro as OAuth-compatible (normalizes to gpt-5.4)", () => {
    expect(isOpenAICodexModel("gpt-5.4-pro")).toBe(true);
  });
});

describe("GPT-5.4 model lineup", () => {
  it("should show GPT-5.4 mini is cheaper than GPT-5.4 for same usage", () => {
    const costMini = calculateCost("gpt-5.4-mini", 100_000, 50_000);
    const cost54 = calculateCost("gpt-5.4", 100_000, 50_000);
    expect(costMini).toBeLessThan(cost54);
  });

  it("should expose 128K max tokens on flagship and mini", () => {
    const modelMini = getModelById("gpt-5.4-mini");
    const model54 = getModelById("gpt-5.4");
    expect(model54?.maxTokens).toBe(128000);
    expect(modelMini?.maxTokens).toBe(128000);
  });

  it("should include GPT-5.4 family in OpenAI model group", () => {
    const openAIModels = CHAT_MODELS.filter((m) => m.group === "OpenAI");
    const modelIds = openAIModels.map((m) => m.id);

    expect(modelIds).toContain("gpt-5.4");
    expect(modelIds).toContain("gpt-5.4-mini");
    expect(modelIds).toContain("gpt-5.4-low");
    expect(modelIds).toContain("gpt-5.4-high");
    expect(modelIds).toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.4-pro");
    expect(modelIds).not.toContain("gpt-5.2");
  });
});

describe("GPT-5.4 Feature Flags", () => {
  it("should mark GPT-5.4 variants as supporting thinking", () => {
    const models = ["gpt-5.4", "gpt-5.4-high", "gpt-5.4-low"];

    models.forEach((modelId) => {
      const model = getModelById(modelId);
      expect(model?.supportsThinking).toBe(true);
    });
  });

  it("should have appropriate reasoning effort levels", () => {
    const gpt54 = getModelById("gpt-5.4");
    const gpt54High = getModelById("gpt-5.4-high");

    expect(gpt54?.reasoning?.effort).toBe("medium");
    expect(gpt54High?.reasoning?.effort).toBe("high");
  });
});

describe("GPT-5.4 Edge Cases", () => {
  it("should handle 272K token threshold (pricing note)", () => {
    const cost272K = calculateCost("gpt-5.4", 272_000, 50_000);
    const cost270K = calculateCost("gpt-5.4", 270_000, 50_000);
    expect(cost272K).toBeGreaterThan(cost270K);
  });

  it("should handle large outputs (128K max)", () => {
    const cost = calculateCost("gpt-5.4", 10_000, 128_000);
    expect(cost).toBeCloseTo(1.945, 2);
  });

  it("should map legacy GPT-5.2 picker ids to GPT-5.4 API id", () => {
    expect(normalizeOpenAIModelId("gpt-5.2")).toBe("gpt-5.4");
    expect(normalizeOpenAIModelId("gpt-5.2-low")).toBe("gpt-5.4");
    expect(normalizeOpenAIModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeOpenAIModelId("gpt-5.4-pro")).toBe("gpt-5.4");
  });

  it("should support OAuth for GPT-5.4 family", () => {
    expect(isOpenAICodexModel("gpt-5.4")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.4-mini")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.4-pro")).toBe(true);
  });

  it("should require Platform API key for retired gpt-5.3-codex on ChatGPT OAuth", () => {
    expect(requiresOpenAIPlatformApiKey("gpt-5.3-codex")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.3-codex")).toBe(false);
    expect(getModelById("gpt-5.3-codex")?.requiresApiKey).toBe(
      "OPENAI_API_KEY",
    );
  });
});
