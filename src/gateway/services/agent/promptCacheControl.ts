/**
 * Anthropic prompt cache breakpoints for the AI SDK path.
 *
 * Marks stable prefix content so repeat turns pay cache-read pricing (~0.1× input).
 * Does NOT mutate the system prompt text — only adds providerOptions metadata.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * @see https://ai-sdk.dev/cookbook/node/dynamic-prompt-caching
 */

/** Minimum chars before Anthropic will cache (Opus ~4096 tokens ≈ 16K chars). */
export const ANTHROPIC_MIN_CACHE_CHARS = 4096 * 4;

export type AnthropicCacheTtl = "5m" | "1h";

export interface PromptCacheOptions {
  /** Provider id from agent config */
  provider: string;
  /** oauth routes use pi-ai, not AI SDK — skip cache_control there */
  authType?: "oauth" | "apiKey";
}

type CacheableMessage = {
  role: string;
  content?: unknown;
  providerOptions?: Record<string, unknown>;
};

function cloneMessage(message: CacheableMessage): CacheableMessage {
  return {
    ...message,
    providerOptions: message.providerOptions
      ? { ...message.providerOptions }
      : undefined,
  };
}

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return sum + (typeof text === "string" ? text.length : 0);
      }
      return sum + JSON.stringify(part).length;
    }, 0);
  }
  return JSON.stringify(content ?? "").length;
}

function withAnthropicCacheControl(
  message: CacheableMessage,
  ttl: AnthropicCacheTtl,
): CacheableMessage {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      anthropic: {
        cacheControl: { type: "ephemeral", ttl },
      },
    },
  };
}

/**
 * Apply Anthropic cache breakpoints to a message array (mutates copies, not inputs).
 *
 * Strategy:
 * 1. System prompt → 1h TTL (large, stable; clears 4K token minimum on Opus)
 * 2. Last message → 5m TTL (incremental conversation prefix per Anthropic guidance)
 */
export function applyAnthropicPromptCacheControl<T extends CacheableMessage>(
  messages: T[],
  options: PromptCacheOptions,
): T[] {
  if (messages.length === 0) return messages;
  if (options.provider !== "anthropic") return messages;
  if (options.authType === "oauth") return messages;

  const cloned = messages.map((message) => cloneMessage(message) as T);

  const systemIndex = cloned.findIndex((message) => message.role === "system");
  if (systemIndex >= 0) {
    const systemMessage = cloned[systemIndex];
    if (contentLength(systemMessage.content) >= ANTHROPIC_MIN_CACHE_CHARS) {
      cloned[systemIndex] = withAnthropicCacheControl(
        systemMessage,
        "1h",
      ) as T;
    }
  }

  const lastIndex = cloned.length - 1;
  cloned[lastIndex] = withAnthropicCacheControl(
    cloned[lastIndex],
    "5m",
  ) as T;

  return cloned;
}

export function shouldEnableAnthropicPromptCache(
  options: PromptCacheOptions,
): boolean {
  return (
    options.provider === "anthropic" && options.authType !== "oauth"
  );
}

/**
 * Extract cache usage from AI SDK step result (v6 usage shape).
 */
export function extractCacheUsageFromStep(step: {
  usage?: {
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    cachedInputTokens?: number;
  };
  providerMetadata?: {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };
}): { cacheReadTokens: number; cacheWriteTokens: number } {
  const details = step.usage?.inputTokenDetails;
  const anthropic = step.providerMetadata?.anthropic;

  const cacheReadTokens =
    details?.cacheReadTokens ??
    anthropic?.cacheReadInputTokens ??
    step.usage?.cachedInputTokens ??
    0;

  const cacheWriteTokens =
    details?.cacheWriteTokens ?? anthropic?.cacheCreationInputTokens ?? 0;

  return { cacheReadTokens, cacheWriteTokens };
}

/** Extract cache usage from AI SDK usage object (finish-step / step-usage). */
export function extractCacheUsageFromUsage(usage: {
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cachedInputTokens?: number;
  providerMetadata?: {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };
}): { cacheReadTokens: number; cacheWriteTokens: number } {
  return extractCacheUsageFromStep({ usage, providerMetadata: usage.providerMetadata });
}
