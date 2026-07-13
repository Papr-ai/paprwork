/**
 * Model ID normalization for OpenAI GPT-5.x
 *
 * The OpenAI API uses dots (gpt-5.6-sol) while some UI/legacy code uses dashes (gpt-5-6-sol).
 *
 * Reasoning suffixes (low, medium, high, xhigh) map to base tier models;
 * reasoning effort is passed separately via providerOptions.reasoningEffort.
 *
 * Deprecated GPT-5.5 picker IDs map to GPT-5.6 Sol API ids for backward compatibility.
 */

import type {
  OpenAIReasoningEffort,
  ReasoningEffort,
} from "../../core/types/agents.js";

const REASONING_SUFFIXES = new Set(["low", "medium", "high", "xhigh"]);

/** Map picker effort (incl. Z.ai "max") to OpenAI SDK reasoningEffort */
export function toOpenAIReasoningEffort(
  effort: ReasoningEffort,
): OpenAIReasoningEffort {
  return effort === "max" ? "xhigh" : effort;
}

function popSegment(id: string): string | undefined {
  const parts = id.split("-");
  return parts.length >= 1 ? parts[parts.length - 1] : undefined;
}

function normalizeDashFormat(modelId: string): string {
  return modelId
    .replace(/gpt-5-2/g, "gpt-5.2")
    .replace(/gpt-5-4/g, "gpt-5.4")
    .replace(/gpt-5-5/g, "gpt-5.5")
    .replace(/gpt-5-6/g, "gpt-5.6");
}

function stripSolReasoningSuffix(n: string): string | null {
  if (!n.startsWith("gpt-5.6-sol-")) {
    return null;
  }
  const last = popSegment(n);
  if (last && REASONING_SUFFIXES.has(last)) {
    return "gpt-5.6-sol";
  }
  return null;
}

/**
 * Normalize OpenAI model ID for API calls.
 * Accepts gpt-5.x-* with dots or dashes (e.g. gpt-5-6-sol, gpt-5-6-terra).
 *
 * @returns API model ID (e.g. "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.3-codex")
 */
export function normalizeOpenAIModelId(modelId: string): string {
  const n = normalizeDashFormat(modelId);

  // Legacy GPT-5.2 family → GPT-5.6 Sol successor
  if (n === "gpt-5.2-codex") {
    return "gpt-5.3-codex";
  }
  if (n === "gpt-5.2" || (n.startsWith("gpt-5.2-") && n !== "gpt-5.2-codex")) {
    return "gpt-5.6-sol";
  }

  // Distinct model IDs (no stripping)
  if (n === "gpt-5.3-codex") {
    return "gpt-5.3-codex";
  }
  if (n === "gpt-5.4-mini") {
    return n;
  }

  // GPT-5.6 family
  if (n === "gpt-5.6" || n === "gpt-5.6-sol") {
    return "gpt-5.6-sol";
  }
  const solWithReasoning = stripSolReasoningSuffix(n);
  if (solWithReasoning) {
    return solWithReasoning;
  }
  if (n === "gpt-5.6-terra") {
    return "gpt-5.6-terra";
  }
  if (n === "gpt-5.6-luna") {
    return "gpt-5.6-luna";
  }

  // Legacy GPT-5.4 variants → GPT-5.6 Sol
  if (n === "gpt-5.4-pro" || n === "gpt-5.4") {
    return "gpt-5.6-sol";
  }
  if (n.startsWith("gpt-5.4-")) {
    const last = popSegment(n);
    if (last && REASONING_SUFFIXES.has(last)) {
      return "gpt-5.6-sol";
    }
  }

  // Legacy GPT-5.5 variants → GPT-5.6 Sol
  if (n === "gpt-5.5-pro" || n === "gpt-5.5") {
    return "gpt-5.6-sol";
  }
  if (n.startsWith("gpt-5.5-")) {
    const last = popSegment(n);
    if (last && REASONING_SUFFIXES.has(last)) {
      return "gpt-5.6-sol";
    }
  }

  // Legacy mini snapshot IDs → GPT-5.4 mini (still kept as mini variant)
  if (n === "gpt-5-mini" || n.startsWith("gpt-5-mini-")) {
    return "gpt-5.4-mini";
  }

  if (n.startsWith("gpt-5")) {
    return n;
  }

  return modelId;
}

/**
 * Normalize Google model ID for API calls.
 * Accepts both gemini-2-5-* (dashes) and gemini-2.5-* (dots).
 *
 * @returns API model ID (e.g. "gemini-2.5-flash", "gemini-3-pro-preview")
 */
export function normalizeGoogleModelId(modelId: string): string {
  return modelId.replace(/gemini-2-5/g, "gemini-2.5");
}

/** Retired on ChatGPT OAuth — require OpenAI Platform API key */
const OPENAI_PLATFORM_ONLY_MODELS = new Set(["gpt-5.3-codex"]);

export function requiresOpenAIPlatformApiKey(modelId: string): boolean {
  return OPENAI_PLATFORM_ONLY_MODELS.has(
    normalizeOpenAIModelId(modelId),
  );
}

/** Models that pi-ai openai-codex (ChatGPT OAuth) supports */
const OPENAI_CODEX_MODELS = new Set([
  "gpt-5.1",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

/**
 * Check if model can use pi-ai openai-codex (OAuth path).
 * Variants like gpt-5-6-sol-low or gpt-5-5-high map to base models in pi-ai.
 */
export function isOpenAICodexModel(modelId: string): boolean {
  const n = normalizeDashFormat(modelId);

  const apiId = normalizeOpenAIModelId(modelId);
  if (requiresOpenAIPlatformApiKey(apiId)) {
    return false;
  }
  if (OPENAI_CODEX_MODELS.has(apiId)) {
    return true;
  }

  // Check GPT-5.6 Sol with reasoning suffix
  if (n.startsWith("gpt-5.6-sol-")) {
    const last = popSegment(n);
    return last !== undefined && REASONING_SUFFIXES.has(last);
  }

  // Check GPT-5.5 with reasoning suffix (maps to 5.6 Sol now)
  if (n.startsWith("gpt-5.5-")) {
    const last = popSegment(n);
    return last !== undefined && REASONING_SUFFIXES.has(last);
  }

  // Check GPT-5.4 with reasoning suffix (maps to 5.6 Sol now)
  if (n.startsWith("gpt-5.4-")) {
    const last = popSegment(n);
    return last !== undefined && REASONING_SUFFIXES.has(last);
  }

  // Legacy OAuth IDs still stored in old chats
  if (n === "gpt-5.4" || n === "gpt-5.4-pro") {
    return true;
  }
  if (n === "gpt-5.2" || n === "gpt-5.2-codex") {
    return true;
  }
  if (n.startsWith("gpt-5.2-")) {
    const last = popSegment(n);
    return last !== undefined && ["low", "high"].includes(last);
  }

  return false;
}
