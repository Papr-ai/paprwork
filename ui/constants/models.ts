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
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    provider: "openai",
    description: "Strong mini model for coding, computer use, and subagents",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.4-low",
    name: "GPT-5.4 (Low Reasoning)",
    provider: "openai",
    description: "Frontier model with faster, lighter reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "low" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    description: "Frontier flagship with balanced reasoning (recommended)",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.4-high",
    name: "GPT-5.4 (High Reasoning)",
    provider: "openai",
    description: "Frontier model with deeper reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "high" },
    maxTokens: 128000,
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
    id: "qwen3.5:4b-q4_k_m",
    name: "Qwen 3.5 4B",
    provider: "ollama",
    description: "Good quality • 10GB+ RAM • Q4 optimized (faster)",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:latest",
    name: "Qwen 3.5 9B (full)",
    provider: "ollama",
    description: "Best quality • 16GB+ RAM • Recommended",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:9b-q4_k_m",
    name: "Qwen 3.5 9B",
    provider: "ollama",
    description: "Best balance • 12GB+ RAM • Q4 optimized (1.5x faster)",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "qwen3.5:27b",
    name: "Qwen 3.5 27B",
    provider: "ollama",
    description: "Highest quality • 32GB+ RAM • 256K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },

  // Gemma (On-Device) — Q4_K_M and QAT optimized variants
  {
    id: "gemma3:270m",
    name: "Gemma 3 270M",
    provider: "ollama",
    description: "Smallest Gemma 3 • ~2GB RAM • Ultra-lightweight",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:1b",
    name: "Gemma 3 1B",
    provider: "ollama",
    description: "Compact • ~4GB RAM • Good for basic tasks",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:4b-it-q4_k_m",
    name: "Gemma 3 4B",
    provider: "ollama",
    description: "Balanced • 8GB+ RAM • Q4 optimized (faster)",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:4b-it-qat",
    name: "Gemma 3 4B QAT",
    provider: "ollama",
    description: "High quality • 9GB+ RAM • Quantization-aware trained",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:latest",
    name: "Gemma 3 (default tag)",
    provider: "ollama",
    description: "Ollama default Gemma 3 build • Recommended to try first",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:12b-it-q4_k_m",
    name: "Gemma 3 12B",
    provider: "ollama",
    description: "High quality • 14GB+ RAM • Q4 optimized • 128K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma3:27b",
    name: "Gemma 3 27B",
    provider: "ollama",
    description: "Largest Gemma 3 • ~32GB+ RAM • 128K context",
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
  "gpt-5.4", // OpenAI flagship
  "gpt-5.4-mini", // OpenAI mini
  "gpt-5.3-codex", // OpenAI Codex (OAuth)
  "gemini-2.5-flash", // Google mid
];

/** Default model IDs when no saved preference - first available wins */
export const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4-6", // Anthropic
  "gpt-5.4", // OpenAI latest
  "gemini-3-flash-preview", // Google
];

export {
  QWEN_RAM_REQUIREMENTS,
  QWEN_MODEL_SIZES,
  GEMMA_RAM_REQUIREMENTS,
  GEMMA_MODEL_SIZES,
  bytesToRamGbRounded,
  pickFittingOllamaModelId,
  getRecommendedQwenModel,
  getRecommendedGemmaModel,
  getOllamaRamRequirementGb,
  ollamaModelFitsHostRam,
} from "../../src/core/utils/ollamaModelFit";
