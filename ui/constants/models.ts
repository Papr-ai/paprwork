/**
 * AI Models Configuration
 * Matching Paprwork v1 model list exactly
 */

export interface AIModel {
  id: string;
  name: string;
  description: string;
  provider: "anthropic" | "openai" | "openai-codex" | "google" | "ollama";
  group: string;
  supportsThinking?: boolean;
  defaultThinkingBudget?: number;
  extendedThinking?: boolean;
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
  };
  maxTokens?: number; // Output token limit
  requiresApiKey: string;
}

export const CHAT_MODELS: AIModel[] = [
  // Anthropic — weakest to strongest (Haiku → Sonnet 4.6 → Opus 4.6 → Opus 4.5 Deep Thinking)
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fastest model, great for simple tasks",
    group: "Anthropic",
    supportsThinking: false,
    defaultThinkingBudget: 0,
    maxTokens: 8192,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    description: "Best balance of speed and intelligence",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    maxTokens: 16000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    description: "Most capable model for complex tasks",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 32000,
    maxTokens: 16000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },

  // OpenAI — weakest to strongest
  {
    id: "gpt-5.2-low",
    name: "GPT-5.2 (Low Reasoning)",
    provider: "openai",
    description: "Latest model with fast reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "low" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    description: "Latest flagship with medium reasoning (recommended)",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.2-high",
    name: "GPT-5.2 (High Reasoning)",
    provider: "openai",
    description: "Latest model with deep reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "high" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    provider: "openai",
    description: "Most intelligent coding model for agentic tasks",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    provider: "openai-codex",
    description: "Latest Codex model via OAuth",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_OAUTH",
  },

  // Google — weakest to strongest
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description:
      "Fastest flash model optimized for cost-efficiency and high throughput",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description:
      "Best price-performance, large scale processing and low-latency",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 8000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    description:
      "Balanced model built for speed, scale, and frontier intelligence",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro",
    description: "Most intelligent model for multimodal understanding",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 16000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },

  // Ollama (On-Device) — smallest to largest
  {
    id: "qwen3.5:0.8b",
    name: "Qwen 3.5 0.8B",
    provider: "ollama",
    description: "Fastest • 4GB+ RAM • Ultra-low resource usage",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:2b",
    name: "Qwen 3.5 2B",
    provider: "ollama",
    description: "Balanced • 8GB+ RAM • Great for laptops",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:4b",
    name: "Qwen 3.5 4B",
    provider: "ollama",
    description: "Good quality • 12GB+ RAM",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:latest",
    name: "Qwen 3.5 9B",
    provider: "ollama",
    description: "Best quality • 16GB+ RAM • Recommended",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:27b",
    name: "Qwen 3.5 27B",
    provider: "ollama",
    description: "Highest quality • 32GB+ RAM • Slower",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
];

// Group models by provider
export const getModelGroups = (): Record<string, AIModel[]> => {
  return CHAT_MODELS.reduce(
    (acc, model) => {
      if (!acc[model.group]) {
        acc[model.group] = [];
      }
      acc[model.group].push(model);
      return acc;
    },
    {} as Record<string, AIModel[]>,
  );
};

// Get model by ID
export const getModelById = (id: string): AIModel | undefined => {
  return CHAT_MODELS.find((m) => m.id === id);
};

/** Mid-tier model IDs per provider, in preference order for default selection */
export const MID_TIER_MODEL_IDS = [
  "claude-sonnet-4-6", // Anthropic mid
  "gpt-5.2", // OpenAI mid
  "gpt-5.3-codex", // OpenAI Codex (OAuth)
  "gemini-2.5-flash", // Google mid
];

/** Default model IDs when no saved preference - first available wins */
export const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4-6", // Anthropic
  "gpt-5.2", // OpenAI
  "gemini-3-flash-preview", // Google
];

/**
 * Get recommended Qwen model based on system RAM
 * @returns Model ID of recommended Qwen variant
 */
export function getRecommendedQwenModel(): string {
  // Default to 9B (best quality, works on most modern machines)
  // Note: System memory detection must be done via Electron IPC from main process
  // This function just returns the safe default
  return "qwen3.5:latest";
}

/**
 * RAM requirements for each Qwen model (in GB)
 */
export const QWEN_RAM_REQUIREMENTS: Record<string, number> = {
  "qwen3.5:0.8b": 4,
  "qwen3.5:2b": 8,
  "qwen3.5:4b": 12,
  "qwen3.5:latest": 16,
  "qwen3.5:27b": 32,
};

/**
 * Model download sizes (in GB)
 */
export const QWEN_MODEL_SIZES: Record<string, number> = {
  "qwen3.5:0.8b": 1.0,
  "qwen3.5:2b": 2.7,
  "qwen3.5:4b": 3.4,
  "qwen3.5:latest": 6.6,
  "qwen3.5:27b": 17,
};
