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
  "gpt-5-6-sol": {
    reasoningLevel: "advanced",
    contextWindow: 1050000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "computer-use", "complex-tasks", "agentic-coding"],
  },
  "gpt-5-6-terra": {
    reasoningLevel: "advanced",
    contextWindow: 1050000,
    speed: "medium",
    cost: "medium",
    specialties: ["coding", "knowledge-work", "analysis"],
  },
  "gpt-5-6-luna": {
    reasoningLevel: "medium",
    contextWindow: 1050000,
    speed: "fast",
    cost: "cheap",
    specialties: ["speed", "classification", "drafts", "high-volume"],
  },
  "gpt-5.5": {
    reasoningLevel: "advanced",
    contextWindow: 1000000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "computer-use", "complex-tasks"],
  },
  "gpt-5.3-codex": {
    reasoningLevel: "medium",
    contextWindow: 128000,
    speed: "medium",
    cost: "medium",
    specialties: ["coding", "structured-output"],
  },
  "gpt-5.4-mini": {
    reasoningLevel: "medium",
    contextWindow: 272000,
    speed: "fast",
    cost: "cheap",
    specialties: ["coding", "computer-use", "subagents", "speed"],
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
  "claude-opus-4-6": {
    reasoningLevel: "advanced",
    contextWindow: 200000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "architecture", "planning", "analysis"],
  },
  "claude-opus-5": {
    reasoningLevel: "advanced",
    contextWindow: 1000000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "agentic", "coding", "long-horizon"],
  },
  "claude-sonnet-4-6": {
    reasoningLevel: "advanced",
    contextWindow: 200000,
    speed: "medium",
    cost: "medium",
    specialties: ["reasoning", "writing", "analysis"],
  },
  "claude-sonnet-5": {
    reasoningLevel: "advanced",
    contextWindow: 1000000,
    speed: "medium",
    cost: "medium",
    specialties: ["reasoning", "agentic", "coding", "tool-use"],
  },
  "claude-fable-5-1": {
    reasoningLevel: "advanced",
    contextWindow: 1000000,
    speed: "slow",
    cost: "expensive",
    specialties: ["reasoning", "agentic", "long-horizon", "coding"],
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
  "gemini-3.1-flash-lite": {
    reasoningLevel: "basic",
    contextWindow: 1048576,
    speed: "fast",
    cost: "cheap",
    specialties: ["speed", "cost-effective", "high-volume"],
  },
  "gemini-3.5-flash": {
    reasoningLevel: "advanced",
    contextWindow: 1048576,
    speed: "fast",
    cost: "medium",
    specialties: ["agentic", "coding", "tool-use", "multimodal"],
  },
  "gemini-3.1-pro-preview": {
    reasoningLevel: "advanced",
    contextWindow: 1048576,
    speed: "medium",
    cost: "expensive",
    specialties: ["reasoning", "research", "multimodal"],
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
  "gemma4:12b": {
    reasoningLevel: "advanced",
    contextWindow: 256000,
    speed: "medium",
    cost: "cheap",
    specialties: ["local", "privacy", "free", "multimodal", "agentic"],
  },
  "gemma3:latest": {
    reasoningLevel: "medium",
    contextWindow: 131072,
    speed: "medium",
    cost: "cheap",
    specialties: ["local", "privacy", "free"],
  },
  "gemma3:4b": {
    reasoningLevel: "medium",
    contextWindow: 131072,
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
    openai: "gpt-5-6-sol",
    "openai-codex": "gpt-5.3-codex",
    anthropic: "claude-sonnet-5",
    google: "gemini-3.5-flash",
    ollama: "qwen3.5:latest",
    cursor: "composer-2.5",
    zai: "glm-5.2",
    groq: "openai/gpt-oss-120b",
    moonshot: "kimi-k3",
  };
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
      reasoning: "gpt-5-6-sol",
      coding: "gpt-5.3-codex",
      writing: "gpt-5-6-sol",
      general: "gpt-5-6-sol",
    },
    "openai-codex": {
      reasoning: "gpt-5.3-codex",
      coding: "gpt-5.3-codex",
      writing: "gpt-5.3-codex",
      general: "gpt-5.3-codex",
    },
    anthropic: {
      reasoning: "claude-fable-5-1",
      coding: "claude-fable-5-1",
      writing: "claude-sonnet-5",
      general: "claude-sonnet-5",
    },
    google: {
      reasoning: "gemini-3.1-pro-preview",
      coding: "gemini-3.5-flash",
      writing: "gemini-3.1-pro-preview",
      general: "gemini-3.5-flash",
    },
    ollama: {
      reasoning: "qwen3.5:latest",
      coding: "qwen3.5:latest",
      writing: "qwen3.5:latest",
      general: "qwen3.5:latest",
    },
    cursor: {
      reasoning: "composer-2.5",
      coding: "composer-2.5",
      writing: "composer-2.5",
      general: "composer-2.5",
    },
    zai: {
      reasoning: "glm-5.2-max",
      coding: "glm-5.2",
      writing: "glm-5.2",
      general: "glm-5.2",
    },
    groq: {
      reasoning: "openai/gpt-oss-120b",
      coding: "qwen/qwen3-32b",
      writing: "qwen/qwen3-32b",
      general: "openai/gpt-oss-120b",
    },
    moonshot: {
      reasoning: "kimi-k3",
      coding: "kimi-k3",
      writing: "kimi-k3",
      general: "kimi-k3",
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
