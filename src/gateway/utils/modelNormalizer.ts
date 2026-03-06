/**
 * Model ID normalization for OpenAI GPT-5.x
 *
 * The OpenAI API uses dots (gpt-5.2) while some UI/legacy code uses dashes (gpt-5-2).
 * This normalizes both formats to the API format (dots).
 *
 * Reasoning variants (low, high, xhigh) map to the same base model "gpt-5.2";
 * reasoning effort is passed separately via providerOptions.reasoningEffort.
 */

/**
 * Normalize OpenAI model ID for API calls.
 * Accepts both gpt-5.2-* (dots) and gpt-5-2-* (dashes).
 *
 * @returns API model ID (e.g. "gpt-5.2", "gpt-5.2-codex", "gpt-5.4", "gpt-5-mini")
 */
export function normalizeOpenAIModelId(modelId: string): string {
  // Normalize dashes to dots for comparison
  const normalized = modelId.replace(/gpt-5-2/g, "gpt-5.2");

  // gpt-5.x-codex and gpt-5.x-pro models are separate - keep as-is (API format)
  if (
    normalized === "gpt-5.2-codex" ||
    normalized === "gpt-5.3-codex" ||
    normalized === "gpt-5.4" ||
    normalized === "gpt-5.4-pro"
  ) {
    return normalized;
  }

  // Variants (low, high, xhigh) -> base model "gpt-5.2"
  if (
    normalized.startsWith("gpt-5.2-") &&
    ["low", "high", "xhigh"].includes(normalized.split("-").pop() ?? "")
  ) {
    return "gpt-5.2";
  }

  // Base gpt-5.2
  if (normalized === "gpt-5.2") {
    return "gpt-5.2";
  }

  // gpt-5-mini, gpt-5-nano, etc. - pass through
  if (normalized.startsWith("gpt-5")) {
    return normalized;
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

/** Models that pi-ai openai-codex (ChatGPT OAuth) supports */
const OPENAI_CODEX_MODELS = new Set([
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-low",
  "gpt-5.2-high",
  "gpt-5.1",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4", // Manually created in AgentService
  "gpt-5.4-pro", // Manually created in AgentService
]);

/**
 * Check if model can use pi-ai openai-codex (OAuth path).
 * Variants like gpt-5.2-low map to base gpt-5.2 in pi-ai.
 */
export function isOpenAICodexModel(modelId: string): boolean {
  const n = modelId.replace(/gpt-5-2/g, "gpt-5.2");
  return (
    OPENAI_CODEX_MODELS.has(n) ||
    (n.startsWith("gpt-5.2-") &&
      ["low", "high"].includes(n.split("-").pop() ?? ""))
  );
}
