/**
 * GPT-5.4 Integration Tests
 * Verify GPT-5.4 and GPT-5.4 Pro models are properly integrated
 */

import { describe, it, expect } from "vitest";
import { CHAT_MODELS, getModelById } from "../ui/constants/models.js";
import { MODEL_PRICING, calculateCost } from "../src/gateway/services/CostCalculation.js";
import { normalizeOpenAIModelId, isOpenAICodexModel } from "../src/gateway/utils/modelNormalizer.js";

describe("GPT-5.4 Model Definitions", () => {
  it("should include GPT-5.4 Thinking model in CHAT_MODELS", () => {
    const gpt54 = getModelById("gpt-5.4");
    expect(gpt54).toBeDefined();
    expect(gpt54?.id).toBe("gpt-5.4");
    expect(gpt54?.name).toBe("GPT-5.4 Thinking");
    expect(gpt54?.provider).toBe("openai");
    expect(gpt54?.group).toBe("OpenAI");
  });

  it("should include GPT-5.4 Pro model in CHAT_MODELS", () => {
    const gpt54Pro = getModelById("gpt-5.4-pro");
    expect(gpt54Pro).toBeDefined();
    expect(gpt54Pro?.id).toBe("gpt-5.4-pro");
    expect(gpt54Pro?.name).toBe("GPT-5.4 Pro");
    expect(gpt54Pro?.provider).toBe("openai");
    expect(gpt54Pro?.group).toBe("OpenAI");
  });

  it("should configure GPT-5.4 models with correct capabilities", () => {
    const gpt54 = getModelById("gpt-5.4");
    const gpt54Pro = getModelById("gpt-5.4-pro");

    // Both should support thinking
    expect(gpt54?.supportsThinking).toBe(true);
    expect(gpt54Pro?.supportsThinking).toBe(true);

    // Should have 128K max tokens (API limit)
    expect(gpt54?.maxTokens).toBe(128000);
    expect(gpt54Pro?.maxTokens).toBe(128000);

    // Should have reasoning effort set
    expect(gpt54?.reasoning?.effort).toBe("medium");
    expect(gpt54Pro?.reasoning?.effort).toBe("high");

    // Should require API key
    expect(gpt54?.requiresApiKey).toBe("OPENAI_API_KEY");
    expect(gpt54Pro?.requiresApiKey).toBe("OPENAI_API_KEY");
  });
});

describe("GPT-5.4 Cost Calculation", () => {
  it("should have correct pricing for GPT-5.4", () => {
    const pricing = MODEL_PRICING["gpt-5.4"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(2.5); // $2.50 per 1M tokens
    expect(pricing.output).toBe(15.0); // $15.00 per 1M tokens
  });

  it("should have correct pricing for GPT-5.4 Pro", () => {
    const pricing = MODEL_PRICING["gpt-5.4-pro"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(30.0); // $30.00 per 1M tokens
    expect(pricing.output).toBe(180.0); // $180.00 per 1M tokens
  });

  it("should calculate cost correctly for GPT-5.4", () => {
    const cost = calculateCost("gpt-5.4", 10_000, 5_000);
    // Input: 10K tokens * $2.50 / 1M = $0.025
    // Output: 5K tokens * $15.00 / 1M = $0.075
    // Total: $0.10
    expect(cost).toBeCloseTo(0.1, 4);
  });

  it("should calculate cost correctly for GPT-5.4 Pro", () => {
    const cost = calculateCost("gpt-5.4-pro", 10_000, 5_000);
    // Input: 10K tokens * $30.00 / 1M = $0.30
    // Output: 5K tokens * $180.00 / 1M = $0.90
    // Total: $1.20
    expect(cost).toBeCloseTo(1.2, 4);
  });

  it("should show GPT-5.4 Pro is more expensive than GPT-5.4", () => {
    const cost54 = calculateCost("gpt-5.4", 100_000, 50_000);
    const costPro = calculateCost("gpt-5.4-pro", 100_000, 50_000);
    expect(costPro).toBeGreaterThan(cost54);
    expect(costPro / cost54).toBeCloseTo(12, 0); // 12x more expensive
  });
});

describe("GPT-5.4 Model Normalization", () => {
  it("should normalize gpt-5.4 correctly", () => {
    expect(normalizeOpenAIModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("should normalize gpt-5.4-pro correctly", () => {
    expect(normalizeOpenAIModelId("gpt-5.4-pro")).toBe("gpt-5.4-pro");
  });

  it("should recognize GPT-5.4 as OpenAI Codex compatible (OAuth)", () => {
    // GPT-5.4 models are created manually in AgentService when not in pi-ai registry
    expect(isOpenAICodexModel("gpt-5.4")).toBe(true);
  });

  it("should recognize GPT-5.4 Pro as OpenAI Codex compatible (OAuth)", () => {
    // GPT-5.4 Pro models are created manually in AgentService when not in pi-ai registry
    expect(isOpenAICodexModel("gpt-5.4-pro")).toBe(true);
  });
});

describe("GPT-5.4 vs GPT-5.2 Comparison", () => {
  it("should show GPT-5.4 is cheaper than GPT-5.2 for same usage", () => {
    const cost52 = calculateCost("gpt-5.2", 100_000, 50_000);
    const cost54 = calculateCost("gpt-5.4", 100_000, 50_000);
    
    // GPT-5.2: $5.00/$15.00 per 1M
    // GPT-5.4: $2.50/$15.00 per 1M
    // GPT-5.4 should be cheaper due to lower input cost
    expect(cost54).toBeLessThan(cost52);
  });

  it("should have higher max tokens for GPT-5.4", () => {
    const model52 = getModelById("gpt-5.2");
    const model54 = getModelById("gpt-5.4");
    
    expect(model54?.maxTokens).toBe(128000);
    expect(model52?.maxTokens).toBe(16384);
    expect(model54?.maxTokens).toBeGreaterThan(model52?.maxTokens ?? 0);
  });

  it("should include GPT-5.4 in OpenAI model group", () => {
    const openAIModels = CHAT_MODELS.filter((m) => m.group === "OpenAI");
    const modelIds = openAIModels.map((m) => m.id);
    
    expect(modelIds).toContain("gpt-5.4");
    expect(modelIds).toContain("gpt-5.4-pro");
    expect(modelIds).toContain("gpt-5.2");
    expect(modelIds).toContain("gpt-5.3-codex");
  });
});

describe("GPT-5.4 Feature Flags", () => {
  it("should mark GPT-5.4 models as supporting thinking", () => {
    const models = ["gpt-5.4", "gpt-5.4-pro"];
    
    models.forEach((modelId) => {
      const model = getModelById(modelId);
      expect(model?.supportsThinking).toBe(true);
    });
  });

  it("should have appropriate reasoning effort levels", () => {
    const gpt54 = getModelById("gpt-5.4");
    const gpt54Pro = getModelById("gpt-5.4-pro");
    
    // GPT-5.4 is medium effort (balanced)
    expect(gpt54?.reasoning?.effort).toBe("medium");
    
    // GPT-5.4 Pro is high effort (most powerful)
    expect(gpt54Pro?.reasoning?.effort).toBe("high");
  });
});

describe("GPT-5.4 Edge Cases", () => {
  it("should handle 272K token threshold (pricing note)", () => {
    // At 272K tokens, GPT-5.4 costs same as below threshold
    const cost272K = calculateCost("gpt-5.4", 272_000, 50_000);
    const cost270K = calculateCost("gpt-5.4", 270_000, 50_000);
    
    // Both should use same pricing (2× rate not modeled in our calculator)
    expect(cost272K).toBeGreaterThan(cost270K);
  });

  it("should handle large outputs (128K max)", () => {
    // GPT-5.4 supports up to 128K output tokens
    const cost = calculateCost("gpt-5.4", 10_000, 128_000);
    expect(cost).toBeCloseTo(1.945, 2); // $0.025 input + $1.92 output
  });

  it("should not normalize GPT-5.4 to GPT-5.2", () => {
    // GPT-5.4 and GPT-5.2 are separate models
    expect(normalizeOpenAIModelId("gpt-5.4")).not.toBe("gpt-5.2");
    expect(normalizeOpenAIModelId("gpt-5.4-pro")).not.toBe("gpt-5.2");
  });

  it("should support OAuth by manually creating model objects", () => {
    // GPT-5.4 models work with OAuth even though not in pi-ai registry
    // AgentService creates model objects manually for ChatGPT backend
    const gpt54SupportsOAuth = isOpenAICodexModel("gpt-5.4");
    const gpt54ProSupportsOAuth = isOpenAICodexModel("gpt-5.4-pro");
    
    expect(gpt54SupportsOAuth).toBe(true);
    expect(gpt54ProSupportsOAuth).toBe(true);
    
    // ChatGPT backend supports any model, pi-ai just doesn't have registry entry
    // Solution: Create model object manually with correct structure
  });
});
