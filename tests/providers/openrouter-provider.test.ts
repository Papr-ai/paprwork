import { describe, expect, it } from "vitest";
import {
  injectOpenRouterRequestBody,
  isOpenRouterModelId,
  OPENROUTER_MODEL_IDS,
} from "../../src/gateway/utils/openrouterModel.js";
import { CHAT_MODELS } from "../../ui/constants/models";
import { MODEL_CONTEXT_WINDOWS } from "../../ui/constants/modelControls";
import { MODEL_PRICING } from "../../src/gateway/services/CostCalculation";
import { isPickerDefaultModelId, getPickerSettingsCatalog } from "../../ui/constants/modelPicker";
import { isPaprProxyOnlyModel } from "../../src/core/constants/paprCloudFeatures";
import { isPremiumProxyModel } from "../../src/core/agents/premiumModels";
import { resolveModelContextWindow } from "../../src/gateway/services/agent/contextBudget";

describe("OpenRouter (via Papr)", () => {
  it("translates effort to OpenRouter's unified reasoning field", () => {
    const body: Record<string, unknown> = { model: "x", reasoning_effort: "high" };
    injectOpenRouterRequestBody(body);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.reasoning_effort).toBeUndefined();
    const b2: Record<string, unknown> = {};
    injectOpenRouterRequestBody(b2, { effort: "low" });
    expect(b2.reasoning).toEqual({ effort: "low" });
    const b3: Record<string, unknown> = {};
    injectOpenRouterRequestBody(b3, { effort: "max" });
    expect(b3.reasoning).toEqual({ effort: "high" });
  });

  it("every allowlisted model is in the catalog, priced, sized, opt-in, open tier", () => {
    const catalog = getPickerSettingsCatalog()["OpenRouter (via Papr)"] ?? [];
    expect(catalog.map((m) => m.id).sort()).toEqual([...OPENROUTER_MODEL_IDS].sort());
    for (const id of OPENROUTER_MODEL_IDS) {
      const m = CHAT_MODELS.find((x) => x.id === id)!;
      expect(m.provider).toBe("openrouter");
      expect(MODEL_CONTEXT_WINDOWS[id]).toBeGreaterThanOrEqual(1_000_000);
      expect(MODEL_PRICING[id]?.input).toBeGreaterThan(0);
      expect(isPickerDefaultModelId(id)).toBe(false);
      expect(isPremiumProxyModel(id)).toBe(false);
      expect(isOpenRouterModelId(id)).toBe(true);
      expect(resolveModelContextWindow("openrouter", id)).toBeGreaterThanOrEqual(1_000_000);
    }
    expect(isPaprProxyOnlyModel("openrouter")).toBe(true);
    expect(isOpenRouterModelId("anthropic/claude-opus-5")).toBe(false);
  });
});
