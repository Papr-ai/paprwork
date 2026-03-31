/**
 * Smart Model Fallback
 * 
 * When a job specifies an unavailable provider, pick the best alternative model
 * based on the original model's characteristics and capabilities.
 */

import type { Provider } from "../../core/types/index.js";

interface ModelCapabilities {
  reasoningLevel: "basic" | "medium" | "advanced";
  contextWindow: number;
  speed: "fast" | "medium" | "slow";
  cost: "cheap" | "medium" | "expensive";
  specialties: string[];
}

/**
 * Model capability profiles
 */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // OpenAI
  "gpt-5.4": {
    reasoningLevel: "advanced",
    contextWindow: 272000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "computer-use", "complex-tasks"],
  },
  "gpt-5.4-pro": {
    reasoningLevel: "advanced",
    contextWindow: 272000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "multi-step", "research"],
  },
  "gpt-5.3-codex": {
    reasoningLevel: "medium",
    contextWindow: 128000,
    speed: "medium",
    cost: "medium",
    specialties: ["coding", "structured-output"],
  },
  "gpt-5.2": {
    reasoningLevel: "medium",
    contextWindow: 128000,
    speed: "medium",
    cost: "medium",
    specialties: ["general-purpose", "balanced"],
  },
  "gpt-4o": {
    reasoningLevel: "medium",
    contextWindow: 128000,
    speed: "fast",
    cost: "medium",
    specialties: ["speed", "multimodal"],
  },
  "gpt-4o-mini": {
    reasoningLevel: "basic",
    contextWindow: 128000,
    speed: "fast",
    cost: "cheap",
    specialties: ["speed", "cost-effective"],
  },

  // Anthropic
  "claude-sonnet-4-6": {
    reasoningLevel: "advanced",
    contextWindow: 200000,
    speed: "medium",
    cost: "medium",
    specialties: ["reasoning", "writing", "analysis"],
  },
  "claude-sonnet-4": {
    reasoningLevel: "advanced",
    contextWindow: 200000,
    speed: "medium",
    cost: "medium",
    specialties: ["reasoning", "computer-use", "coding"],
  },
  "claude-3-5-haiku": {
    reasoningLevel: "basic",
    contextWindow: 200000,
    speed: "fast",
    cost: "cheap",
    specialties: ["speed", "cost-effective"],
  },

  // Google
  "gemini-2.5-flash": {
    reasoningLevel: "medium",
    contextWindow: 1000000,
    speed: "fast",
    cost: "cheap",
    specialties: ["speed", "large-context", "multimodal"],
  },
  "gemini-2.5-pro": {
    reasoningLevel: "advanced",
    contextWindow: 2000000,
    speed: "medium",
    cost: "medium",
    specialties: ["reasoning", "massive-context", "research"],
  },

  // Ollama
  "qwen3.5:latest": {
    reasoningLevel: "medium",
    contextWindow: 256000,
    speed: "medium",
    cost: "cheap",
    specialties: ["local", "privacy", "free"],
  },
};

/**
 * Get the best fallback model for a given original model.
 * Considers model capabilities, reasoning level, and use case.
 */
export async function getBestFallbackModel(
  _originalProvider: Provider,
  originalModel: string,
  availableProviders: Array<{ provider: Provider; hasAuth: boolean }>,
): Promise<{ provider: Provider; model: string } | null> {
  const { getAvailableProviders } = await import("./defaultProvider.js");

  // Get list of available providers (with auth)
  const available = availableProviders ?? (await getAvailableProviders());
  if (available.length === 0) return null;

  // Get capabilities of the original model
  const originalCapabilities = MODEL_CAPABILITIES[originalModel];

  // Default models by provider
  const defaultModelByProvider: Record<Provider, string> = {
    openai: "gpt-5.2",
    "openai-codex": "gpt-5.3-codex",
    anthropic: "claude-sonnet-4-6",
    google: "gemini-2.5-flash",
    ollama: "qwen3.5:latest",
  };

  // If we don't know the original model's capabilities, use default provider
  if (!originalCapabilities) {
    const firstAvailable = available[0];
    return {
      provider: firstAvailable.provider,
      model: defaultModelByProvider[firstAvailable.provider],
    };
  }

  // Score each available provider based on capability match
  const scoredProviders = available.map((providerInfo) => {
    const provider = providerInfo.provider;
    const candidateModel = defaultModelByProvider[provider];
    const candidateCapabilities = MODEL_CAPABILITIES[candidateModel];

    if (!candidateCapabilities) {
      return { provider, model: candidateModel, score: 0 };
    }

    let score = 0;

    // Reasoning level match (most important)
    if (candidateCapabilities.reasoningLevel === originalCapabilities.reasoningLevel) {
      score += 100;
    } else if (
      originalCapabilities.reasoningLevel === "advanced" &&
      candidateCapabilities.reasoningLevel === "medium"
    ) {
      score += 50; // Acceptable downgrade
    } else if (
      originalCapabilities.reasoningLevel === "medium" &&
      candidateCapabilities.reasoningLevel === "advanced"
    ) {
      score += 80; // Upgrade is good
    }

    // Context window (important for long documents)
    if (candidateCapabilities.contextWindow >= originalCapabilities.contextWindow) {
      score += 30;
    } else {
      score += 15; // Smaller context is acceptable
    }

    // Speed match
    if (candidateCapabilities.speed === originalCapabilities.speed) {
      score += 20;
    }

    // Cost consideration (prefer similar or cheaper)
    if (candidateCapabilities.cost === originalCapabilities.cost) {
      score += 10;
    } else if (
      originalCapabilities.cost === "expensive" &&
      candidateCapabilities.cost === "medium"
    ) {
      score += 15; // Cheaper is better
    }

    // Specialty overlap
    const specialtyOverlap = originalCapabilities.specialties.filter((s) =>
      candidateCapabilities.specialties.includes(s),
    );
    score += specialtyOverlap.length * 10;

    return { provider, model: candidateModel, score };
  });

  // Sort by score (highest first)
  scoredProviders.sort((a, b) => b.score - a.score);

  // Return best match
  const best = scoredProviders[0];
  return {
    provider: best.provider,
    model: best.model,
  };
}

/**
 * Get upgrade model if available.
 * For reasoning-heavy tasks, prefer advanced models when available.
 */
export function getUpgradeModelForTask(
  provider: Provider,
  taskType: "reasoning" | "coding" | "writing" | "general",
): string {
  const upgradeMap: Record<
    Provider,
    Record<string, string>
  > = {
    openai: {
      reasoning: "gpt-5.4",
      coding: "gpt-5.3-codex",
      writing: "gpt-5.2",
      general: "gpt-5.2",
    },
    "openai-codex": {
      reasoning: "gpt-5.3-codex",
      coding: "gpt-5.3-codex",
      writing: "gpt-5.3-codex",
      general: "gpt-5.3-codex",
    },
    anthropic: {
      reasoning: "claude-sonnet-4-6",
      coding: "claude-sonnet-4",
      writing: "claude-sonnet-4-6",
      general: "claude-sonnet-4-6",
    },
    google: {
      reasoning: "gemini-2.5-pro",
      coding: "gemini-2.5-flash",
      writing: "gemini-2.5-pro",
      general: "gemini-2.5-flash",
    },
    ollama: {
      reasoning: "qwen3.5:latest",
      coding: "qwen3.5:latest",
      writing: "qwen3.5:latest",
      general: "qwen3.5:latest",
    },
  };

  return upgradeMap[provider]?.[taskType] ?? upgradeMap[provider]?.general;
}

/**
 * Detect task type from job command/prompt.
 * Used to suggest better models when falling back.
 */
export function detectTaskType(
  command: string,
): "reasoning" | "coding" | "writing" | "general" {
  const lowerCommand = command.toLowerCase();

  // Reasoning indicators
  if (
    lowerCommand.includes("analyze") ||
    lowerCommand.includes("reason") ||
    lowerCommand.includes("think") ||
    lowerCommand.includes("complex") ||
    lowerCommand.includes("multi-step")
  ) {
    return "reasoning";
  }

  // Coding indicators
  if (
    lowerCommand.includes("code") ||
    lowerCommand.includes("implement") ||
    lowerCommand.includes("refactor") ||
    lowerCommand.includes("debug") ||
    lowerCommand.includes("function")
  ) {
    return "coding";
  }

  // Writing indicators
  if (
    lowerCommand.includes("write") ||
    lowerCommand.includes("draft") ||
    lowerCommand.includes("compose") ||
    lowerCommand.includes("summarize") ||
    lowerCommand.includes("report")
  ) {
    return "writing";
  }

  return "general";
}
