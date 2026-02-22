/**
 * Model fallback manager - Handles multi-provider fallback logic
 * Automatically retries with different models on failure
 */

import type { Provider, ModelInfo } from "../types/index.js";

interface FallbackConfig {
  maxRetries: number;
  retryableErrors: string[];
}

const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  maxRetries: 3,
  retryableErrors: ["rate_limit", "timeout", "overloaded"],
};

/**
 * Available models by provider
 */
const AVAILABLE_MODELS: Record<Provider, ModelInfo[]> = {
  anthropic: [
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      contextWindow: 200000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "anthropic",
      contextWindow: 1000000,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "anthropic",
      contextWindow: 1000000,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "claude-opus-4-5-thinking",
      name: "Claude Opus 4.5 (Extended Thinking)",
      provider: "anthropic",
      contextWindow: 200000,
      supportsThinking: true,
      supportsVision: true,
    },
  ],
  openai: [
    {
      id: "gpt-5-2",
      name: "GPT-5.2",
      provider: "openai",
      contextWindow: 128000,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      id: "gpt-5-2-thinking",
      name: "GPT-5.2 (Reasoning)",
      provider: "openai",
      contextWindow: 128000,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      provider: "openai",
      contextWindow: 128000,
      supportsThinking: false,
      supportsVision: true,
    },
  ],
  "openai-codex": [
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      provider: "openai-codex",
      contextWindow: 128000,
      supportsThinking: true,
      supportsVision: true,
    },
  ],
  google: [
    {
      id: "gemini-2-0-flash",
      name: "Gemini 2.0 Flash",
      provider: "google",
      contextWindow: 1000000,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "gemini-1-5-pro",
      name: "Gemini 1.5 Pro",
      provider: "google",
      contextWindow: 2000000,
      supportsThinking: false,
      supportsVision: true,
    },
  ],
};

export class ModelFallback {
  private config: FallbackConfig;

  constructor(config?: Partial<FallbackConfig>) {
    this.config = { ...DEFAULT_FALLBACK_CONFIG, ...config };
  }

  /**
   * Get available models for a provider
   */
  getModelsForProvider(provider: Provider): ModelInfo[] {
    return AVAILABLE_MODELS[provider] || [];
  }

  /**
   * Get all available models
   */
  getAllModels(): ModelInfo[] {
    return Object.values(AVAILABLE_MODELS).flat();
  }

  /**
   * Get model info by ID
   */
  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.getAllModels().find((m) => m.id === modelId);
  }

  /**
   * Check if an error is retryable
   */
  isRetryableError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();
    return this.config.retryableErrors.some((retryable) =>
      errorMessage.includes(retryable),
    );
  }

  /**
   * Get fallback model for a given model
   */
  getFallbackModel(currentModel: string, provider: Provider): string | null {
    const models = this.getModelsForProvider(provider);
    const currentIndex = models.findIndex((m) => m.id === currentModel);

    if (currentIndex === -1 || currentIndex === models.length - 1) {
      return null;
    }

    return models[currentIndex + 1].id;
  }

  /**
   * Check if should retry based on attempt count
   */
  shouldRetry(attemptCount: number): boolean {
    return attemptCount < this.config.maxRetries;
  }
}
