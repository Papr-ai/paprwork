/**
 * AI Models Configuration
 * Matching Paprwork v1 model list exactly
 */

import type { Provider, ModelReasoning } from "../../src/core/types/agents";

export interface AIModel {
  id: string;
  name: string;
  description: string;
  provider: Provider;
  group: string;
  supportsThinking?: boolean;
  defaultThinkingBudget?: number;
  extendedThinking?: boolean;
  reasoning?: ModelReasoning;
  maxTokens?: number; // Output token limit
  requiresApiKey: string;
}

export const CHAT_MODELS: AIModel[] = [
  // Anthropic — weakest to strongest (Haiku → Sonnet → Opus → Fable 5.1)
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
    description: "Previous Sonnet — balanced speed and intelligence",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    maxTokens: 16000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    description:
      "Latest Sonnet — agentic coding, tool use, browser/terminal work (recommended)",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 0,
    maxTokens: 128000,
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
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "anthropic",
    description: "Latest frontier model with enhanced reasoning",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 32000,
    maxTokens: 16000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-opus-4-7-high",
    name: "Claude Opus 4.7 (High Reasoning)",
    provider: "anthropic",
    description: "Opus 4.7 with extended thinking for deep analysis",
    group: "Anthropic",
    supportsThinking: true,
    extendedThinking: true,
    defaultThinkingBudget: 64000,
    maxTokens: 16000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "anthropic",
    description:
      "Latest Opus frontier — adaptive thinking, 1M context, agentic coding",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 0,
    maxTokens: 128000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    provider: "anthropic",
    description:
      "Most capable Claude — adaptive thinking, 1M context, long-horizon agentic coding and research",
    group: "Anthropic",
    supportsThinking: true,
    defaultThinkingBudget: 0,
    maxTokens: 128000,
    requiresApiKey: "ANTHROPIC_API_KEY",
  },

  // Z.ai GLM — via Papr proxy (OpenAI-compatible API)
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    provider: "zai",
    description:
      "Z.ai frontier coding model — 1M context, strong agentic and long-horizon tasks",
    group: "Z.ai (via Papr)",
    supportsThinking: true,
    reasoning: { effort: "high" },
    maxTokens: 131072,
    requiresApiKey: "PAPR_API_KEY",
  },
  {
    id: "glm-5.2-max",
    name: "GLM-5.2 (Max Reasoning)",
    provider: "zai",
    description:
      "GLM-5.2 with maximum reasoning effort for complex multi-step coding",
    group: "Z.ai (via Papr)",
    supportsThinking: true,
    reasoning: { effort: "max" },
    maxTokens: 131072,
    requiresApiKey: "PAPR_API_KEY",
  },

  // Moonshot Kimi — via Papr proxy (OpenAI-compatible API)
  {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    description:
      "Moonshot's 2.8T flagship — 1M context, native vision, deep reasoning",
    group: "Moonshot (via Papr)",
    supportsThinking: true,
    reasoning: { effort: "max" },
    maxTokens: 131072,
    requiresApiKey: "PAPR_API_KEY",
  },

  // Groq — via Papr proxy (fast LPU inference, auto prompt caching on GPT-OSS)
  {
    id: "qwen/qwen3-32b",
    name: "Qwen3 32B",
    provider: "groq",
    description:
      "Qwen3 32B on Groq — 131k context, fast inference (~662 TPS)",
    group: "Groq (via Papr)",
    supportsThinking: false,
    maxTokens: 131072,
    requiresApiKey: "PAPR_API_KEY",
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    provider: "groq",
    description:
      "OpenAI GPT-OSS 120B on Groq — 128k context, reasoning, automatic prompt caching",
    group: "Groq (via Papr)",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 131072,
    requiresApiKey: "PAPR_API_KEY",
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
    id: "gpt-5-6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    description:
      "Fastest GPT-5.6 tier — high-volume tasks, drafts, and classification",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    description:
      "Balanced GPT-5.6 tier — everyday coding, analysis, and knowledge work",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-6-sol-low",
    name: "GPT-5.6 Sol (Low Reasoning)",
    provider: "openai",
    description: "GPT-5.6 flagship with faster, lighter reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "low" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    description:
      "Latest frontier flagship — coding, agentic work, computer use (recommended)",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5-6-sol-high",
    name: "GPT-5.6 Sol (High Reasoning)",
    provider: "openai",
    description: "GPT-5.6 flagship with deeper reasoning for complex tasks",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "high" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.5-low",
    name: "GPT-5.5 (Low Reasoning)",
    provider: "openai",
    description: "Previous-gen frontier model with lighter reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "low" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    description: "Previous-gen frontier flagship with balanced reasoning",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 128000,
    requiresApiKey: "OPENAI_API_KEY",
  },
  {
    id: "gpt-5.5-high",
    name: "GPT-5.5 (High Reasoning)",
    provider: "openai",
    description: "Previous-gen frontier model with deeper reasoning",
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
    description: "Codex model — requires OpenAI API key (not available via ChatGPT OAuth)",
    group: "OpenAI",
    supportsThinking: true,
    reasoning: { effort: "medium" },
    maxTokens: 16384,
    requiresApiKey: "OPENAI_API_KEY",
  },

  // Google — weakest to strongest (see ai.google.dev/gemini-api/docs/models)
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description:
      "Legacy budget tier — consider Gemini 3.1 Flash-Lite for new projects",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 5000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    description:
      "Most cost-efficient Gemini 3 — high-volume tasks, translation, moderation",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 3000,
    maxTokens: 65536,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description:
      "Legacy price-performance flash — consider Gemini 3.5 Flash for agentic work",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 8000,
    maxTokens: 8192,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    description:
      "GA flagship flash — agentic loops, coding, long-horizon tool use (recommended)",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 10000,
    maxTokens: 65536,
    requiresApiKey: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    description:
      "Most capable Gemini — complex reasoning, deep research, multimodal analysis",
    provider: "google",
    group: "Google",
    supportsThinking: true,
    defaultThinkingBudget: 16000,
    maxTokens: 65536,
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

  // Gemma 4 (On-Device) — latest open models (see deepmind.google/models/gemma)
  {
    id: "gemma4:e2b",
    name: "Gemma 4 E2B",
    provider: "ollama",
    description: "Edge • ~6GB RAM • Mobile/IoT • 128K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma4:e4b",
    name: "Gemma 4 E4B",
    provider: "ollama",
    description: "Edge • ~10GB RAM • Multimodal • 128K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma4:12b",
    name: "Gemma 4 12B",
    provider: "ollama",
    description: "Recommended • ~16GB RAM • Unified multimodal • 256K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },
  {
    id: "gemma4:26b",
    name: "Gemma 4 26B",
    provider: "ollama",
    description: "Workstation • ~24GB RAM • MoE (4B active) • 256K context",
    group: "Ollama (On-Device)",
    supportsThinking: false,
    maxTokens: 8192,
    requiresApiKey: "NONE",
  },

  // Gemma 3 (On-Device) — legacy Q4_K_M and QAT optimized variants
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
  "claude-sonnet-5", // Anthropic mid (latest)
  "claude-sonnet-4-6", // Anthropic mid (legacy)
  "gpt-5-6-sol", // OpenAI flagship
  "gpt-5-6-terra", // OpenAI balanced
  "gpt-5.4-mini", // OpenAI mini
  "gpt-5.3-codex", // OpenAI Codex (API key only)
  "gemini-3.5-flash", // Google mid
];

/** Default model IDs when no saved preference - first available wins */
export const DEFAULT_MODEL_IDS = [
  "claude-sonnet-5", // Anthropic
  "claude-sonnet-4-6", // Anthropic legacy
  "gpt-5-6-sol", // OpenAI latest
  "gemini-3.5-flash", // Google
];

export {
  QWEN_RAM_REQUIREMENTS,
  QWEN_MODEL_SIZES,
  GEMMA_RAM_REQUIREMENTS,
  GEMMA_MODEL_SIZES,
  GEMMA4_RAM_REQUIREMENTS,
  GEMMA4_MODEL_SIZES,
  bytesToRamGbRounded,
  pickFittingOllamaModelId,
  getRecommendedQwenModel,
  getRecommendedGemmaModel,
  getOllamaRamRequirementGb,
  ollamaModelFitsHostRam,
} from "../../src/core/utils/ollamaModelFit";
