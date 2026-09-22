/**
 * Claude Opus 5.5 and GPT-6 Astra.
 *
 * Two of these models' properties are not variations on what shipped before,
 * and those are what this pins:
 *
 *  - Opus 5.5 reads cache at 0.05x its input rate, half the global default.
 *    Cache read is the largest single component of Anthropic spend (Issue 90),
 *    so billing it at the default overstates by 2x on the dominant term.
 *  - Opus 5.5 rejects `thinking: { type: "disabled" }`. Opus 5 accepts it.
 *    The two ids differ by one suffix, so every guard that separates them is
 *    a substring test one character away from being wrong.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ModelFallback } from "../src/core/agents/ModelFallback";
import { calculateCostWithCache } from "../src/gateway/services/CostCalculation";
import {
  anthropicModelRequiresAlwaysOnThinking,
  anthropicModelUsesAdaptiveThinking,
} from "../src/gateway/utils/anthropicAdaptiveThinking";
import { openAIModelAcceptsMaxEffort } from "../src/gateway/utils/openAIMaxEffort";
import {
  isOpenAICodexModel,
  normalizeOpenAIModelId,
  toOpenAIReasoningEffort,
} from "../src/gateway/utils/modelNormalizer";
import {
  augmentPiAiAnthropicStreamOptions,
  buildAdaptiveThinkingOnPayload,
} from "../src/gateway/services/providers/piAiAnthropicAdaptiveThinking";
import {
  effortLevelsForModel,
  modelSupportsFast,
  modelSupportsThinkingToggle,
  MODEL_CONTEXT_WINDOWS,
} from "../ui/constants/modelControls";
import { CHAT_MODELS } from "../ui/constants/models";
import type { AIModel } from "../ui/constants/models";
import {
  PICKER_DEFAULT_MODEL_IDS,
  PRE_OPUS_5_5_PICKER_DEFAULT_MODEL_IDS,
  migrateEnabledPickerModelIds,
} from "../ui/constants/modelPicker";

const OPUS_5_5 = "claude-opus-5-5";
const ASTRA = "gpt-6-astra";

const repoRoot = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * Drop comment lines so a stale comment cannot vouch for deleted code
 * (Issue 97, Issue 107).
 *
 * Line-based rather than regex-based on purpose. A `/\*[\s\S]*?\*\//` pass
 * over `appJobs.ts` eats 46KB of it, because glob strings such as `**​/*` open
 * a comment that never closes — and it removes the very enum entries this
 * asserts on, so the test fails against correct code. Working line by line
 * cannot run away: the worst case is one line kept that should have gone.
 */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function modelById(id: string): AIModel {
  const model = CHAT_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`${id} missing from CHAT_MODELS`);
  return model;
}

describe("registry", () => {
  it("lists both models in the picker catalogue", () => {
    expect(modelById(OPUS_5_5).provider).toBe("anthropic");
    expect(modelById(ASTRA).provider).toBe("openai");
  });

  it("agrees with the gateway registry on context window", () => {
    // The renderer copy is what the controls read; the gateway copy is what
    // the request is budgeted against. `tests/model-controls.test.ts` asserts
    // the whole table, so this only pins that both ids are *in* it — an id
    // omitted there passes that test by never being compared.
    const fallback = new ModelFallback();
    expect(MODEL_CONTEXT_WINDOWS[OPUS_5_5]).toBe(1_000_000);
    expect(MODEL_CONTEXT_WINDOWS[ASTRA]).toBe(1_050_000);
    expect(fallback.getModelInfo(OPUS_5_5)?.contextWindow).toBe(1_000_000);
    expect(fallback.getModelInfo(ASTRA)?.contextWindow).toBe(1_050_000);
  });

  it("offers both in the default picker and upgrades existing users", () => {
    expect(PICKER_DEFAULT_MODEL_IDS).toContain(OPUS_5_5);
    expect(PICKER_DEFAULT_MODEL_IDS).toContain(ASTRA);

    // Without the migration branch a user who never edited their picker keeps
    // the old list forever and never sees either model.
    const migrated = migrateEnabledPickerModelIds([
      ...PRE_OPUS_5_5_PICKER_DEFAULT_MODEL_IDS,
    ]);
    expect(migrated).toContain(OPUS_5_5);
    expect(migrated).toContain(ASTRA);
  });

  it("upgrades a saved list that still holds an effort variant", () => {
    // `glm-5.2-max` collapses to `glm-5.2` only after the per-id pass, so a
    // list carrying one matches no snapshot until then. Checking the snapshot
    // before the collapse alone leaves these users on the old defaults.
    const withVariant = PRE_OPUS_5_5_PICKER_DEFAULT_MODEL_IDS.map((id) =>
      id === "glm-5.2" ? "glm-5.2-max" : id,
    );
    const migrated = migrateEnabledPickerModelIds(withVariant);
    expect(migrated).toContain(OPUS_5_5);
    expect(migrated).toContain(ASTRA);
  });

  it("leaves a hand-picked list alone", () => {
    const chosen = ["claude-sonnet-5", "gpt-5-6-sol"];
    expect(migrateEnabledPickerModelIds(chosen)).toEqual(chosen);
  });

  it("accepts both as sub-agent and job models", () => {
    for (const rel of [
      "src/core/tools/delegation.ts",
      "src/core/tools/appJobs.ts",
    ]) {
      const body = stripComments(read(rel));
      expect(body, `${rel} missing ${OPUS_5_5}`).toContain(`"${OPUS_5_5}"`);
      expect(body, `${rel} missing ${ASTRA}`).toContain(`"${ASTRA}"`);
    }
  });

  it("registers both in the fallback capability table", () => {
    const body = stripComments(read("src/gateway/utils/smartFallback.ts"));
    expect(body).toContain(`"${OPUS_5_5}"`);
    expect(body).toContain(`"${ASTRA}"`);
  });
});

describe("pricing", () => {
  const MILLION = 1_000_000;

  it("bills Opus 5.5 at $4 in / $20 out", () => {
    const cost = calculateCostWithCache(OPUS_5_5, {
      promptTokens: MILLION,
      completionTokens: MILLION,
    });
    expect(cost).toBeCloseTo(24, 6);
  });

  it("bills an Opus 5.5 cache read at 0.05x input, not the 0.1x default", () => {
    // $4 input x 0.05 = $0.20/M, which is what Anthropic publishes. The
    // default multiplier would charge $0.40/M.
    const cost = calculateCostWithCache(OPUS_5_5, {
      promptTokens: MILLION,
      completionTokens: 0,
      cacheReadTokens: MILLION,
    });
    expect(cost).toBeCloseTo(0.2, 6);
    expect(cost).not.toBeCloseTo(0.4, 6);
  });

  it("bills an Opus 5.5 cache write at the 1.25x default", () => {
    // $4 x 1.25 = $5/M, which matches Anthropic's published 5m write rate.
    const cost = calculateCostWithCache(OPUS_5_5, {
      promptTokens: MILLION,
      completionTokens: 0,
      cacheWriteTokens: MILLION,
    });
    expect(cost).toBeCloseTo(5, 6);
  });

  it("leaves models without an override on the global multipliers", () => {
    // The override plumbing must not change what every other model costs.
    // Opus 5 is $5/$25, so a cache read is $0.50/M at the 0.1x default.
    const cost = calculateCostWithCache("claude-opus-5", {
      promptTokens: MILLION,
      completionTokens: 0,
      cacheReadTokens: MILLION,
    });
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it("bills Astra at $10 in / $50 out with default cache rates", () => {
    // OpenAI publishes $1/M cached input and $12.50/M cache writes against
    // $10 input, which are exactly 0.1x and 1.25x.
    expect(
      calculateCostWithCache(ASTRA, {
        promptTokens: MILLION,
        completionTokens: MILLION,
      }),
    ).toBeCloseTo(60, 6);
    expect(
      calculateCostWithCache(ASTRA, {
        promptTokens: MILLION,
        completionTokens: 0,
        cacheReadTokens: MILLION,
      }),
    ).toBeCloseTo(1, 6);
    expect(
      calculateCostWithCache(ASTRA, {
        promptTokens: MILLION,
        completionTokens: 0,
        cacheWriteTokens: MILLION,
      }),
    ).toBeCloseTo(12.5, 6);
  });

  it("prices both models rather than silently returning zero", () => {
    // An unpriced model returns 0, which reads as free rather than as unknown.
    for (const id of [OPUS_5_5, ASTRA]) {
      expect(
        calculateCostWithCache(id, {
          promptTokens: 1000,
          completionTokens: 1000,
        }),
      ).toBeGreaterThan(0);
    }
  });
});

describe("always-on thinking", () => {
  it("separates Opus 5.5 from Opus 5", () => {
    // `"claude-opus-5".includes("opus-5-5")` is false, which is the whole
    // reason the guard can tell them apart. Matching on `opus-5` would take
    // the disable away from Opus 5, where it works.
    expect(anthropicModelRequiresAlwaysOnThinking(OPUS_5_5)).toBe(true);
    expect(anthropicModelRequiresAlwaysOnThinking("claude-opus-5")).toBe(false);
    expect(anthropicModelRequiresAlwaysOnThinking("claude-fable-5-1")).toBe(
      true,
    );
    expect(anthropicModelRequiresAlwaysOnThinking("claude-sonnet-5")).toBe(
      false,
    );
  });

  it("still routes Opus 5.5 through the adaptive-thinking override", () => {
    // Inherited via the existing `opus-5` match. If that ever narrows, the
    // model streams empty thinking deltas and the turn renders as nothing.
    expect(anthropicModelUsesAdaptiveThinking(OPUS_5_5)).toBe(true);
  });

  it("hides the thinking toggle where the request would be rejected", () => {
    expect(modelSupportsThinkingToggle(modelById(OPUS_5_5))).toBe(false);
    expect(modelSupportsThinkingToggle(modelById("claude-fable-5-1"))).toBe(
      false,
    );
    expect(modelSupportsThinkingToggle(modelById("claude-opus-5"))).toBe(true);
  });

  it("keeps effort on Opus 5.5 even though the toggle is gone", () => {
    // Hiding both rows would leave the model with no reasoning control at all.
    expect(effortLevelsForModel(modelById(OPUS_5_5))).toContain("medium");
  });

  it("ignores a stale thinking:false on the OAuth route", () => {
    // A chat that was on Sonnet and switched to Opus 5.5 still carries the
    // saved off switch. Forwarding it fails the turn rather than reasoning
    // less, so the payload must come back enabled.
    const onPayload = buildAdaptiveThinkingOnPayload(OPUS_5_5, "high", false);
    const patched = onPayload?.({}, {}) as Record<string, unknown>;
    expect(patched.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    // Effort survives the coercion. The disabled branch strips it, so a guard
    // that only restored `thinking` would leave the model with no depth dial.
    expect(patched.output_config).toEqual({ effort: "high" });
  });

  it("still promotes xhigh to max on Opus 5.5", () => {
    // Inherited from the existing `opus-5` match in the effort mapper.
    const onPayload = buildAdaptiveThinkingOnPayload(OPUS_5_5, "xhigh", false);
    const patched = onPayload?.({}, {}) as Record<string, unknown>;
    expect(patched.output_config).toEqual({ effort: "max" });
  });

  it("still honours thinking:false where the model accepts it", () => {
    const onPayload = buildAdaptiveThinkingOnPayload(
      "claude-opus-5",
      "high",
      false,
    );
    const patched = onPayload?.({}, {}) as Record<string, unknown>;
    expect(patched.thinking).toEqual({ type: "disabled" });
  });

  it("patches the Opus 5.5 stream options rather than passing them through", () => {
    const base = { apiKey: "sk-ant-oat-test", sessionId: "s" };
    const augmented = augmentPiAiAnthropicStreamOptions(
      OPUS_5_5,
      "high",
      base,
      false,
    );
    expect(augmented.onPayload).toBeTypeOf("function");
  });

  it("does not send thinking:disabled to Opus 5.5 on the AI SDK route", () => {
    // The UI gate hides the row, but a saved `thinking: false` can still reach
    // the request from a chat that was on another model, so the send site
    // needs the same predicate.
    const source = stripComments(read("src/gateway/services/AgentService.ts"));
    const decl = source.indexOf("const thinkingDisabled");
    expect(decl, "thinkingDisabled guard missing").toBeGreaterThan(-1);

    const guard = source.slice(decl, decl + 220);
    expect(guard).toContain("config.thinking === false");
    expect(guard).toContain("anthropicModelRequiresAlwaysOnThinking");

    // And effort must be gated on the resolved value, not on the raw setting,
    // or Opus 5.5 keeps thinking but loses its depth dial.
    const effortAt = source.indexOf("anthropicOptions.effort");
    expect(effortAt).toBeGreaterThan(-1);
    const effortGuard = source.slice(effortAt - 320, effortAt);
    expect(effortGuard).toContain("!thinkingDisabled");
    expect(effortGuard).not.toContain("config.thinking !== false");
  });
});

describe("ChatGPT routing for Astra", () => {
  it("leaves the id untouched", () => {
    // Every rule in the normalizer is scoped to GPT-5, and OpenAI names Astra
    // with a dash, so there is no dot-form to convert to.
    expect(normalizeOpenAIModelId(ASTRA)).toBe(ASTRA);
  });

  it("routes Astra through the ChatGPT OAuth provider", () => {
    // Astra ships on ChatGPT Plus/Pro as well as the API. Left out of the
    // allowlist it would be refused for anyone signed in with ChatGPT.
    expect(isOpenAICodexModel(ASTRA)).toBe(true);
  });

  it("does not drag other GPT-6 ids into the OAuth path", () => {
    expect(isOpenAICodexModel("gpt-6-nonexistent")).toBe(false);
  });
});

describe("max effort", () => {
  it("passes the model id at every send site", () => {
    // Without the model id the coercion cannot know the request can carry
    // `max`, so it silently folds to `xhigh` — the UI would offer a row that
    // does nothing. Mutation-testing found dropping the argument at either
    // site was invisible, so the sites are counted rather than the helper
    // alone: a new one that forgets the id must fail here.
    const senders = [
      "src/gateway/services/AgentService.ts",
      "src/core/agents/MastraAgent.ts",
    ];
    let callSites = 0;
    for (const rel of senders) {
      const source = stripComments(
        readFileSync(join(__dirname, "..", rel), "utf8"),
      );
      // Skip the `const { toOpenAIReasoningEffort } = await import(...)`
      // destructures, which are not calls.
      const calls = source.match(/toOpenAIReasoningEffort\(([\s\S]*?)\)/g) ?? [];
      for (const call of calls) {
        callSites += 1;
        expect(call).toContain("config.model");
      }
    }
    expect(callSites).toBe(2);
  });

  it("recognises Astra and nothing else in the OpenAI family", () => {
    expect(openAIModelAcceptsMaxEffort(ASTRA)).toBe(true);
    expect(openAIModelAcceptsMaxEffort("gpt-5-6-sol")).toBe(false);
    expect(openAIModelAcceptsMaxEffort("gpt-5.3-codex")).toBe(false);
  });

  it("offers the max row only where the request can carry it", () => {
    expect(effortLevelsForModel(modelById(ASTRA))).toContain("max");
    expect(effortLevelsForModel(modelById("gpt-5-6-sol"))).not.toContain("max");
  });

  it("sends max to Astra and folds it to xhigh elsewhere", () => {
    // Folding it on Astra would send one level below what the user selected,
    // which reads as the model ignoring the control.
    expect(toOpenAIReasoningEffort("max", ASTRA)).toBe("max");
    expect(toOpenAIReasoningEffort("max", "gpt-5-6-sol")).toBe("xhigh");
    expect(toOpenAIReasoningEffort("max")).toBe("xhigh");
    expect(toOpenAIReasoningEffort("high", ASTRA)).toBe("high");
  });

  it("passes the model id at every send site", () => {
    // Omitting it is not a type error — the parameter is optional so the call
    // still compiles and quietly folds max down.
    for (const rel of [
      "src/gateway/services/AgentService.ts",
      "src/core/agents/MastraAgent.ts",
    ]) {
      const body = stripComments(read(rel));
      const at = body.indexOf("toOpenAIReasoningEffort(config.reasoning.effort");
      expect(
        at,
        `${rel} calls toOpenAIReasoningEffort without a model id`,
      ).toBe(-1);
    }
  });
});

describe("fast mode", () => {
  it("offers fast mode on Opus 5.5 with an API key", () => {
    expect(modelSupportsFast(modelById(OPUS_5_5), "apiKey")).toBe(true);
  });

  it("hides it on OAuth, where pi-ai has no speed parameter", () => {
    expect(modelSupportsFast(modelById(OPUS_5_5), "oauth")).toBe(false);
  });
});
