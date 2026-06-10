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
      id: "claude-fable-5",
      name: "Claude Fable 5",
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
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      provider: "openai",
      contextWindow: 272000,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      contextWindow: 1000000,
      supportsThinking: true,
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
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash-Lite",
      provider: "google",
      contextWindow: 1048576,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      provider: "google",
      contextWindow: 1048576,
      supportsThinking: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      provider: "google",
      contextWindow: 1048576,
      supportsThinking: true,
      supportsVision: true,
    },
  ],
  ollama: [
    {
      id: "qwen3.5:0.8b",
      name: "Qwen 3.5 0.8B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "qwen3.5:2b",
      name: "Qwen 3.5 2B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "qwen3.5:4b",
      name: "Qwen 3.5 4B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "qwen3.5:latest",
      name: "Qwen 3.5 9B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "qwen3.5:27b",
      name: "Qwen 3.5 27B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "gemma4:12b",
      name: "Gemma 4 12B",
      provider: "ollama",
      contextWindow: 256000,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      id: "gemma3:270m",
      name: "Gemma 3 270M",
      provider: "ollama",
      contextWindow: 32768,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "gemma3:1b",
      name: "Gemma 3 1B",
      provider: "ollama",
      contextWindow: 32768,
      supportsThinking: false,
      supportsVision: false,
    },
    {
      id: "gemma3:4b",
      name: "Gemma 3 4B",
      provider: "ollama",
      contextWindow: 131072,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      id: "gemma3:latest",
      name: "Gemma 3 (default)",
      provider: "ollama",
      contextWindow: 131072,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      id: "gemma3:12b",
      name: "Gemma 3 12B",
      provider: "ollama",
      contextWindow: 131072,
      supportsThinking: false,
      supportsVision: true,
    },
    {
      id: "gemma3:27b",
      name: "Gemma 3 27B",
      provider: "ollama",
      contextWindow: 131072,
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
