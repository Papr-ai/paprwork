/**
 * AI Models Configuration
 * Matching Paprwork v1 model list exactly
 */

export interface AIModel {
  id: string;
  name: string;
  description: string;
  provider: "anthropic" | "openai" | "google";
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
  {
    id: "claude-opus-4-5-thinking",
    name: "Claude Opus 4.5 (Deep Thinking)",
    provider: "anthropic",
    description: "Extended thinking for complex problems",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 32000,
    extendedThinking: true,
    maxTokens: 8192,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },

  // OpenAI — weakest to strongest
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    provider: "openai",
    description:
      "Fast, efficient model for simple tasks and high-volume operations",
    group: "OpenAI",
    supportsThinking: false,
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },
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
    id: "gpt-5.2-xhigh",
    name: "GPT-5.2 (Extra High Reasoning)",
    provider: "openai",
    description: "Latest model with maximum reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "xhigh" },
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
