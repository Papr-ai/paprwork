/**
 * GPT-5.6 Integration Tests
 * Verify GPT-5.6 family models are properly integrated
 */

import { describe, it, expect } from "vitest";
import { CHAT_MODELS, getModelById } from "../ui/constants/models.js";
import { MODEL_PRICING, calculateCost } from "../src/gateway/services/CostCalculation.js";
import {
  normalizeOpenAIModelId,
  isOpenAICodexModel,
  requiresOpenAIPlatformApiKey,
} from "../src/gateway/utils/modelNormalizer.js";

describe("GPT-5.6 Model Definitions", () => {
  it("should include GPT-5.6 Sol in CHAT_MODELS", () => {
    const sol = getModelById("gpt-5-6-sol");
    expect(sol).toBeDefined();
    expect(sol?.id).toBe("gpt-5-6-sol");
    expect(sol?.name).toBe("GPT-5.6 Sol");
    expect(sol?.provider).toBe("openai");
    expect(sol?.group).toBe("OpenAI");
  });

  it("should include Terra and Luna tiers", () => {
    const terra = getModelById("gpt-5-6-terra");
    const luna = getModelById("gpt-5-6-luna");

    expect(terra?.name).toBe("GPT-5.6 Terra");
    expect(luna?.name).toBe("GPT-5.6 Luna");
    expect(terra?.supportsThinking).toBe(true);
    expect(luna?.supportsThinking).toBe(true);
  });

  it("should configure Sol reasoning variants correctly", () => {
    const solLow = getModelById("gpt-5-6-sol-low");
    const sol = getModelById("gpt-5-6-sol");
    const solHigh = getModelById("gpt-5-6-sol-high");

    expect(solLow?.reasoning?.effort).toBe("low");
    expect(sol?.reasoning?.effort).toBe("medium");
    expect(solHigh?.reasoning?.effort).toBe("high");

    expect(sol?.maxTokens).toBe(128000);
    expect(sol?.requiresApiKey).toBe("OPENAI_API_KEY");
  });
});

describe("GPT-5.6 Cost Calculation", () => {
  it("should have correct pricing for GPT-5.6 Sol", () => {
    const pricing = MODEL_PRICING["gpt-5.6-sol"];
    expect(pricing).toBeDefined();
    expect(pricing.input).toBe(5.0);
    expect(pricing.output).toBe(30.0);
  });

  it("should have correct pricing for Terra and Luna", () => {
    expect(MODEL_PRICING["gpt-5.6-terra"]).toEqual({
      input: 2.5,
      output: 15.0,
    });
    expect(MODEL_PRICING["gpt-5.6-luna"]).toEqual({
      input: 1.0,
      output: 6.0,
    });
  });

  it("should calculate cost correctly for GPT-5.6 Sol", () => {
    const cost = calculateCost("gpt-5-6-sol", 10_000, 5_000);
    expect(cost).toBeCloseTo(0.2, 4);
  });

  it("should price Luna cheaper than Terra and Sol for same usage", () => {
    const costLuna = calculateCost("gpt-5-6-luna", 100_000, 50_000);
    const costTerra = calculateCost("gpt-5-6-terra", 100_000, 50_000);
    const costSol = calculateCost("gpt-5-6-sol", 100_000, 50_000);
    expect(costLuna).toBeLessThan(costTerra);
    expect(costTerra).toBeLessThan(costSol);
  });
});

describe("GPT-5.6 Model Normalization", () => {
  it("should normalize gpt-5-6-sol correctly", () => {
    expect(normalizeOpenAIModelId("gpt-5-6-sol")).toBe("gpt-5.6-sol");
  });

  it("should normalize Terra and Luna", () => {
    expect(normalizeOpenAIModelId("gpt-5-6-terra")).toBe("gpt-5.6-terra");
    expect(normalizeOpenAIModelId("gpt-5-6-luna")).toBe("gpt-5.6-luna");
  });

  it("should strip Sol reasoning suffixes to base API id", () => {
    expect(normalizeOpenAIModelId("gpt-5-6-sol-low")).toBe("gpt-5.6-sol");
    expect(normalizeOpenAIModelId("gpt-5-6-sol-high")).toBe("gpt-5.6-sol");
  });

  it("should map gpt-5.6 alias to gpt-5.6-sol", () => {
    expect(normalizeOpenAIModelId("gpt-5.6")).toBe("gpt-5.6-sol");
  });

  it("should map legacy gpt-5.5 variants to gpt-5.6-sol", () => {
    expect(normalizeOpenAIModelId("gpt-5.5")).toBe("gpt-5.6-sol");
    expect(normalizeOpenAIModelId("gpt-5-5-high")).toBe("gpt-5.6-sol");
  });

  it("should recognize GPT-5.6 Sol as OpenAI Codex compatible (OAuth)", () => {
    expect(isOpenAICodexModel("gpt-5-6-sol")).toBe(true);
    expect(isOpenAICodexModel("gpt-5-6-terra")).toBe(true);
    expect(isOpenAICodexModel("gpt-5-6-luna")).toBe(true);
  });

  it("should still require platform API key for gpt-5.3-codex", () => {
    expect(requiresOpenAIPlatformApiKey("gpt-5.3-codex")).toBe(true);
    expect(isOpenAICodexModel("gpt-5.3-codex")).toBe(false);
  });
});

describe("GPT-5.6 model lineup ordering", () => {
  it("should list GPT-5.6 Sol before legacy GPT-5.5 in CHAT_MODELS", () => {
    const openaiModels = CHAT_MODELS.filter((m) => m.group === "OpenAI");
    const solIndex = openaiModels.findIndex((m) => m.id === "gpt-5-6-sol");
    const legacyIndex = openaiModels.findIndex((m) => m.id === "gpt-5.5");
    expect(solIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThan(solIndex);
  });
});
