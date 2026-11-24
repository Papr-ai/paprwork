/**
 * Gemini 4 Argon and Claude Fable 5.2 registry + billing guards.
 */

import { describe, it, expect } from "vitest";
import { ModelFallback } from "../../src/core/agents/ModelFallback";
import { calculateCostWithCache } from "../../src/gateway/services/CostCalculation";
import {
  anthropicModelRequiresAlwaysOnThinking,
  anthropicModelUsesAdaptiveThinking,
} from "../../src/gateway/utils/anthropicAdaptiveThinking";
import {
  effortLevelsForModel,
  modelSupportsThinkingToggle,
  MODEL_CONTEXT_WINDOWS,
} from "../../ui/constants/modelControls";
import { CHAT_MODELS } from "../../ui/constants/models";
import type { AIModel } from "../../ui/constants/models";
import {
  PICKER_DEFAULT_MODEL_IDS,
  PRE_FABLE_52_GEMINI_4_PICKER_DEFAULT_MODEL_IDS,
  migrateEnabledPickerModelIds,
} from "../../ui/constants/modelPicker";

const FABLE_52 = "claude-fable-5-2";
const GEMINI_4 = "gemini-4-argon";

function modelById(id: string): AIModel {
  const model = CHAT_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`${id} missing from CHAT_MODELS`);
  return model;
}

describe("registry", () => {
  it("lists both models in the picker catalogue", () => {
    expect(modelById(FABLE_52).provider).toBe("anthropic");
    expect(modelById(GEMINI_4).provider).toBe("google");
  });

  it("agrees with the gateway registry on context window", () => {
    const fallback = new ModelFallback();
    expect(MODEL_CONTEXT_WINDOWS[FABLE_52]).toBe(1_000_000);
    expect(MODEL_CONTEXT_WINDOWS[GEMINI_4]).toBe(1_048_576);
    expect(fallback.getModelInfo(FABLE_52)?.contextWindow).toBe(1_000_000);
    expect(fallback.getModelInfo(GEMINI_4)?.contextWindow).toBe(1_048_576);
  });

  it("offers both in the default picker and upgrades the prior default list", () => {
    expect(PICKER_DEFAULT_MODEL_IDS).toContain(FABLE_52);
    expect(PICKER_DEFAULT_MODEL_IDS).toContain(GEMINI_4);

    const migrated = migrateEnabledPickerModelIds([
      ...PRE_FABLE_52_GEMINI_4_PICKER_DEFAULT_MODEL_IDS,
    ]);
    expect(migrated).toContain(FABLE_52);
    expect(migrated).toContain(GEMINI_4);
  });
});

describe("Fable 5.2 thinking", () => {
  it("uses adaptive always-on thinking like Fable 5.1", () => {
    expect(anthropicModelUsesAdaptiveThinking(FABLE_52)).toBe(true);
    expect(anthropicModelRequiresAlwaysOnThinking(FABLE_52)).toBe(true);
    expect(modelSupportsThinkingToggle(modelById(FABLE_52))).toBe(false);
    expect(effortLevelsForModel(modelById(FABLE_52))).toContain("max");
  });

  it("does not treat Opus 5 as always-on", () => {
    expect(anthropicModelRequiresAlwaysOnThinking("claude-opus-5")).toBe(false);
  });
});

describe("billing", () => {
  it("bills Fable 5.2 cache read at 0.025x input", () => {
    const cost = calculateCostWithCache(FABLE_52, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.2, 5);
  });

  it("bills Gemini 4 Argon at intro pricing", () => {
    const cost = calculateCostWithCache(GEMINI_4, {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(12.0, 5);
  });
});
