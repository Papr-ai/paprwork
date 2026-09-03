/**
 * pi-ai 0.64 lacks registry entries for Claude Fable 5.1 / Opus 5 and treats them
 * as budget-based thinking models. Anthropic requires adaptive thinking for these
 * models, and Fable/Opus 5 stream empty thinking deltas unless display=summarized.
 *
 * We patch the outgoing Messages API payload via pi-ai's onPayload hook.
 */

export type PiAiReasoningLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type AnthropicAdaptiveEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface AnthropicThinkingConfig {
  type: "adaptive";
  display?: "summarized";
}

interface AnthropicMessagesParams {
  thinking?: AnthropicThinkingConfig | { type: string; budget_tokens?: number };
  output_config?: { effort?: AnthropicAdaptiveEffort; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PiAiAnthropicStreamOptions {
  apiKey: string;
  sessionId: string;
  signal?: AbortSignal;
  reasoning?: PiAiReasoningLevel;
  cacheRetention?: "none" | "short" | "long";
  headers?: Record<string, string>;
  onPayload?: (
    params: AnthropicMessagesParams,
    model: unknown,
  ) =>
    | AnthropicMessagesParams
    | undefined
    | Promise<AnthropicMessagesParams | undefined>;
}

/** Minimum Claude Code CLI version Anthropic accepts for OAuth-backed frontier models. */
export const CLAUDE_CODE_OAUTH_USER_AGENT_VERSION = "2.1.251";

/** Models pi-ai misconfigures (budget thinking) but Anthropic requires adaptive-only. */
export function requiresPiAiAdaptiveThinkingOverride(modelId: string): boolean {
  return (
    modelId.includes("fable") ||
    modelId.includes("opus-5") ||
    modelId.includes("opus-4-8") ||
    modelId.includes("opus-4.8") ||
    modelId.includes("sonnet-5")
  );
}

export function mapPiAiReasoningToAnthropicEffort(
  level: PiAiReasoningLevel,
  modelId: string,
): AnthropicAdaptiveEffort {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (
        modelId.includes("fable") ||
        modelId.includes("opus-5") ||
        modelId.includes("opus-4-8") ||
        modelId.includes("opus-4.8") ||
        modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6")
      ) {
        return "max";
      }
      return "high";
    default:
      return "medium";
  }
}

export function buildAdaptiveThinkingOnPayload(
  modelId: string,
  reasoningLevel: PiAiReasoningLevel,
): PiAiAnthropicStreamOptions["onPayload"] {
  const effort = mapPiAiReasoningToAnthropicEffort(reasoningLevel, modelId);

  return (params) => {
    const existingOutputConfig =
      params.output_config && typeof params.output_config === "object"
        ? params.output_config
        : {};

    return {
      ...params,
      thinking: {
        type: "adaptive",
        display: "summarized",
      },
      output_config: {
        ...existingOutputConfig,
        effort,
      },
    };
  };
}

export function augmentPiAiAnthropicStreamOptions(
  modelId: string,
  reasoningLevel: PiAiReasoningLevel,
  base: PiAiAnthropicStreamOptions,
): PiAiAnthropicStreamOptions {
  const isOAuth = base.apiKey.includes("sk-ant-oat");
  const headers = isOAuth
    ? {
        ...base.headers,
        "user-agent": `claude-cli/${CLAUDE_CODE_OAUTH_USER_AGENT_VERSION}`,
      }
    : base.headers;

  if (!requiresPiAiAdaptiveThinkingOverride(modelId)) {
    return headers === base.headers ? base : { ...base, headers };
  }

  console.log(
    `[AgentService] Applying adaptive thinking override for ${modelId} ` +
      `(effort=${mapPiAiReasoningToAnthropicEffort(reasoningLevel, modelId)}, display=summarized)`,
  );

  return {
    ...base,
    headers,
    onPayload: buildAdaptiveThinkingOnPayload(modelId, reasoningLevel),
  };
}
