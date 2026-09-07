/**
 * Per-chat model controls: capability gating, settings resolution, config shape.
 *
 * The cases that matter are the ones where a stored value must be *dropped*:
 * a saved choice that a newly selected model cannot honour has to fall back
 * rather than ride along into a request that will misbehave or overspend.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { ModelFallback } from "../src/core/agents/ModelFallback";
import {
  CONTEXT_OPTIONS,
  DEFAULT_CONTEXT_LIMIT,
  EFFORT_VARIANT_MODELS,
  MODEL_CONTEXT_WINDOWS,
  contextOptionsForModel,
  effortLevelsForModel,
  formatContextLimit,
  modelSupportsEffort,
  modelSupportsFast,
  modelSupportsThinkingToggle,
  unpackEffortVariant,
} from "../ui/constants/modelControls";
import type { AIModel } from "../ui/constants/models";
import { CHAT_MODELS } from "../ui/constants/models";
import {
  buildAgentConfig,
  resolveModelSettings,
} from "../ui/utils/buildAgentConfig";
import {
  adoptEffortFromVariant,
  forgetChatSettings,
  readChatSettings,
  renameChatSettings,
  sanitizeSettings,
  writeChatSettings,
} from "../ui/utils/chatModelSettings";
import {
  PICKER_DEFAULT_MODEL_IDS,
  isChatPickerModelId,
  migrateEnabledPickerModelIds,
  migratePickerModelId,
} from "../ui/constants/modelPicker";

/** Minimal localStorage so these run without a DOM (matches chat-model-scoping). */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

function model(overrides: Partial<AIModel> = {}): AIModel {
  return {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "",
    provider: "anthropic",
    group: "Anthropic",
    supportsThinking: true,
    requiresApiKey: "ANTHROPIC_API_KEY",
    ...overrides,
  };
}

describe("effort variant collapse", () => {
  it("unpacks a variant id into its base model and implied effort", () => {
    expect(unpackEffortVariant("gpt-5-6-sol-high")).toEqual({
      modelId: "gpt-5-6-sol",
      effort: "high",
    });
    expect(unpackEffortVariant("glm-5.2-max")).toEqual({
      modelId: "glm-5.2",
      effort: "max",
    });
  });

  it("leaves a non-variant id untouched", () => {
    expect(unpackEffortVariant("claude-opus-5")).toEqual({
      modelId: "claude-opus-5",
    });
  });

  it("never maps a variant onto another variant", () => {
    for (const { modelId } of Object.values(EFFORT_VARIANT_MODELS)) {
      expect(EFFORT_VARIANT_MODELS[modelId]).toBeUndefined();
    }
  });

  it("only names base models that still exist in the catalog", () => {
    const known = new Set(CHAT_MODELS.map((entry) => entry.id));
    for (const { modelId } of Object.values(EFFORT_VARIANT_MODELS)) {
      expect(known).toContain(modelId);
    }
  });
});

describe("capability gating", () => {
  it("offers a thinking toggle only where the request can carry an off switch", () => {
    expect(modelSupportsThinkingToggle(model())).toBe(true);
    expect(modelSupportsThinkingToggle(model({ provider: "google" }))).toBe(
      true,
    );
    // OpenAI reasoning is intrinsic — a toggle would be wired to nothing.
    expect(modelSupportsThinkingToggle(model({ provider: "openai" }))).toBe(
      false,
    );
  });

  it("hides every reasoning control on a non-thinking model", () => {
    const plain = model({ provider: "groq", supportsThinking: false });
    expect(modelSupportsThinkingToggle(plain)).toBe(false);
    expect(modelSupportsEffort(plain)).toBe(false);
  });

  it("offers max effort only where the provider accepts it", () => {
    expect(effortLevelsForModel(model())).toContain("max");
    expect(effortLevelsForModel(model({ provider: "openai" }))).not.toContain(
      "max",
    );
  });

  // `effort` is part of Anthropic's adaptive thinking surface. The
  // budget-thinking models take `{ type: "enabled", budgetTokens }` and have no
  // effort field, so an Effort row there would send a parameter the request
  // cannot carry. This mirrors the gateway gate in AgentService.
  it("offers Anthropic effort only on adaptive-thinking models", () => {
    for (const id of [
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ]) {
      expect(modelSupportsEffort(model({ id })), id).toBe(true);
    }
    for (const id of [
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-6",
    ]) {
      expect(modelSupportsEffort(model({ id })), id).toBe(false);
    }
  });

  it("caps Anthropic effort at max only on the frontier models", () => {
    expect(effortLevelsForModel(model({ id: "claude-opus-5" }))).toContain(
      "max",
    );
    expect(effortLevelsForModel(model({ id: "claude-fable-5-1" }))).toContain(
      "max",
    );
    // The gateway maps xhigh -> high for Sonnet 5, so max is not on offer.
    expect(
      effortLevelsForModel(model({ id: "claude-sonnet-5" })),
    ).not.toContain("max");
  });

  it("restricts fast mode to Opus-class models on an API key", () => {
    expect(modelSupportsFast(model(), "apiKey")).toBe(true);
    // pi-ai has no `speed` parameter, so OAuth would silently ignore it.
    expect(modelSupportsFast(model(), "oauth")).toBe(false);
    expect(modelSupportsFast(model({ id: "claude-sonnet-5" }), "apiKey")).toBe(
      false,
    );
  });
});

describe("context options", () => {
  it("never offers more context than the model's window", () => {
    const narrow = model({ id: "qwen/qwen3-32b", provider: "groq" });
    for (const option of contextOptionsForModel(narrow)) {
      expect(option).toBeLessThanOrEqual(
        MODEL_CONTEXT_WINDOWS["qwen/qwen3-32b"],
      );
    }
  });

  it("still returns one honest choice for a model below the smallest option", () => {
    const tiny = model({ id: "gpt-5.3-codex", provider: "openai" });
    expect(contextOptionsForModel(tiny)).toEqual([128_000]);
  });

  it("formats the options the way the row renders them", () => {
    expect(CONTEXT_OPTIONS.map(formatContextLimit)).toEqual([
      "200K",
      "400K",
      "1M",
    ]);
  });
});

describe("resolveModelSettings", () => {
  it("defaults context to the narrowest option rather than the model's window", () => {
    // The whole point of the control: a 1M window should not be the default
    // spend, because every token in the budget is re-sent on every step.
    expect(resolveModelSettings(model(), {}).contextLimit).toBe(
      DEFAULT_CONTEXT_LIMIT,
    );
  });

  it("drops a stored context that the newly selected model cannot honour", () => {
    const narrow = model({ id: "qwen/qwen3-32b", provider: "groq" });
    const resolved = resolveModelSettings(narrow, {
      contextLimit: 1_000_000,
    });
    expect(resolved.contextLimit).toBe(131_072);
  });

  it("drops a stored effort the new provider does not accept", () => {
    const openai = model({
      provider: "openai",
      reasoning: { effort: "medium" },
    });
    expect(resolveModelSettings(openai, { effort: "max" }).effort).toBe(
      "medium",
    );
  });

  it("keeps a stored effort the provider does accept", () => {
    expect(resolveModelSettings(model(), { effort: "max" }).effort).toBe("max");
  });

  it("falls back to the model's own default effort when unset", () => {
    const glm = model({
      id: "glm-5.2",
      provider: "zai",
      reasoning: { effort: "high" },
    });
    expect(resolveModelSettings(glm, {}).effort).toBe("high");
  });

  it("treats thinking as on unless the user turned it off", () => {
    expect(resolveModelSettings(model(), {}).thinking).toBe(true);
    expect(resolveModelSettings(model(), { thinking: false }).thinking).toBe(
      false,
    );
  });

  it("ignores a thinking-off setting on a model with no off switch", () => {
    const openai = model({ provider: "openai" });
    expect(resolveModelSettings(openai, { thinking: false }).thinking).toBe(
      true,
    );
  });
});

describe("buildAgentConfig", () => {
  const systemPrompt = "sp";

  it("carries provider, model and output cap through unchanged", () => {
    const config = buildAgentConfig({
      model: model({ maxTokens: 128_000 }),
      settings: {},
      systemPrompt,
    });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-opus-5");
    expect(config.maxTokens).toBe(128_000);
    expect(config.systemPrompt).toBe(systemPrompt);
  });

  it("does not use a zero thinking budget to mean 'off'", () => {
    // Opus 5 ships defaultThinkingBudget: 0 and still thinks adaptively, so a
    // zero budget alone must never be read as the user disabling reasoning.
    const config = buildAgentConfig({
      model: model({ defaultThinkingBudget: 0 }),
      settings: {},
      systemPrompt,
    });
    expect(config.thinkingBudget).toBe(0);
    expect(config.thinking).toBeUndefined();
  });

  it("sends an explicit off flag when the user disables thinking", () => {
    const config = buildAgentConfig({
      model: model({ defaultThinkingBudget: 0 }),
      settings: { thinking: false },
      systemPrompt,
    });
    expect(config.thinking).toBe(false);
  });

  it("omits reasoning entirely when the model has no effort control", () => {
    const config = buildAgentConfig({
      model: model({ provider: "groq", supportsThinking: false }),
      settings: { effort: "high" },
      systemPrompt,
    });
    expect(config.reasoning).toBeUndefined();
  });

  it("sends fast only on a supported model with an API key", () => {
    const settings = { fast: true };
    expect(
      buildAgentConfig({
        model: model(),
        settings,
        systemPrompt,
        authType: "apiKey",
      }).speed,
    ).toBe("fast");
    expect(
      buildAgentConfig({
        model: model(),
        settings,
        systemPrompt,
        authType: "oauth",
      }).speed,
    ).toBeUndefined();
  });
});

describe("context window table", () => {
  it("matches the gateway registry the request is actually budgeted against", () => {
    // The renderer cannot import ModelFallback (its `.js` specifiers do not
    // resolve under Vite), so the table is restated in the UI. This is the
    // guard that keeps the copy from drifting away from the real value.
    const fallback = new ModelFallback();
    for (const [modelId, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      const info = fallback.getModelInfo(modelId);
      expect(
        info?.contextWindow,
        `${modelId} context window drifted from ModelFallback`,
      ).toBe(window);
    }
  });
});

describe("chat settings persistence", () => {
  beforeEach(() => {
    const storage = new MemoryStorage();
    // @ts-expect-error -- test shim for a browser global
    globalThis.window = { localStorage: storage };
  });

  it("keeps one chat's settings out of another's", () => {
    writeChatSettings("chat-a", { effort: "max" });
    expect(readChatSettings("chat-b")).toEqual({});
  });

  it("merges a patch instead of replacing the whole entry", () => {
    writeChatSettings("chat-a", { effort: "high" });
    writeChatSettings("chat-a", { contextLimit: 400_000 });
    expect(readChatSettings("chat-a")).toEqual({
      effort: "high",
      contextLimit: 400_000,
    });
  });

  it("carries settings across the temp-to-permanent chat id rename", () => {
    writeChatSettings("temp-1", { fast: true });
    renameChatSettings("temp-1", "chat-1");
    expect(readChatSettings("chat-1")).toEqual({ fast: true });
    expect(readChatSettings("temp-1")).toEqual({});
  });

  it("forgets a deleted chat", () => {
    writeChatSettings("chat-a", { effort: "low" });
    forgetChatSettings("chat-a");
    expect(readChatSettings("chat-a")).toEqual({});
  });

  it("discards malformed stored values rather than sending them", () => {
    expect(sanitizeSettings({ effort: "turbo" })).toBeNull();
    expect(sanitizeSettings({ contextLimit: -5 })).toBeNull();
    expect(sanitizeSettings({ thinking: "yes" })).toBeNull();
    expect(sanitizeSettings({ effort: "high", contextLimit: -5 })).toEqual({
      effort: "high",
    });
  });

  it("survives a corrupt storage blob", () => {
    window.localStorage.setItem("paprwork_chat_model_settings", "{not json");
    expect(readChatSettings("chat-a")).toEqual({});
  });

  it("adopts the effort a retired variant model implied", () => {
    expect(adoptEffortFromVariant("chat-a", "gpt-5-6-sol-high")).toBe("high");
    expect(readChatSettings("chat-a")).toEqual({ effort: "high" });
  });

  it("does not overwrite an effort the user already chose", () => {
    writeChatSettings("chat-a", { effort: "low" });
    expect(adoptEffortFromVariant("chat-a", "gpt-5-6-sol-high")).toBeNull();
    expect(readChatSettings("chat-a").effort).toBe("low");
  });

  it("does nothing for a model that was never a variant", () => {
    expect(adoptEffortFromVariant("chat-a", "claude-opus-5")).toBeNull();
    expect(readChatSettings("chat-a")).toEqual({});
  });
});

describe("picker collapse", () => {
  it("stops listing every effort variant as its own model", () => {
    for (const variantId of Object.keys(EFFORT_VARIANT_MODELS)) {
      expect(
        isChatPickerModelId(variantId),
        `${variantId} is still offered as a separate picker row`,
      ).toBe(false);
    }
  });

  it("still lists the base model each variant collapses onto", () => {
    for (const { modelId } of Object.values(EFFORT_VARIANT_MODELS)) {
      expect(isChatPickerModelId(modelId)).toBe(true);
    }
  });

  it("migrates a saved variant preference onto its base model", () => {
    expect(migratePickerModelId("gpt-5-6-sol-high")).toBe("gpt-5-6-sol");
    expect(migratePickerModelId("glm-5.2-max")).toBe("glm-5.2");
  });

  it("upgrades a saved default list without dropping any row", () => {
    // The list users have today, before the collapse.
    const saved = [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5-1",
      "gpt-5-6-sol",
      "glm-5.2-max",
      "qwen/qwen3-32b",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
    ];
    const migrated = migrateEnabledPickerModelIds(saved);
    expect(migrated).toEqual([...PICKER_DEFAULT_MODEL_IDS]);
    expect(migrated).toHaveLength(saved.length);
  });

  it("leaves no default pointing at an id the picker hides", () => {
    for (const id of PICKER_DEFAULT_MODEL_IDS) {
      expect(isChatPickerModelId(id), `${id} is hidden but default`).toBe(true);
    }
  });
});

describe("renderer -> gateway import boundary", () => {
  it("keeps anthropicAdaptiveThinking importable from the renderer", () => {
    // `modelControls` reaches across into the gateway for this one predicate,
    // so the effort control is gated by the same rule the request is built
    // from rather than a second hand-kept list. That only works because the
    // file is a leaf: gateway modules import each other with `.js` specifiers,
    // which Vite will not resolve back to `.ts`, so the first import added
    // here would break the renderer build — and only the release build, since
    // the dev server is more forgiving. Hence this guard.
    const source = readFileSync(
      new URL(
        "../src/gateway/utils/anthropicAdaptiveThinking.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const runtimeImports = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .filter((line) => !/^\s*import\s+type\s/.test(line));
    expect(
      runtimeImports,
      "anthropicAdaptiveThinking must stay import-free to remain renderer-safe",
    ).toEqual([]);
  });
});
