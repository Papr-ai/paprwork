/**
 * Default Provider Resolution
 * 
 * Resolves the best available provider and model for jobs when not explicitly specified.
 * Priority: Use what the user has configured/authenticated.
 */

import os from "node:os";
import type { Provider } from "../../core/types/index.js";
import {
  bytesToRamGbRounded,
  getRecommendedQwenModel,
} from "../../core/utils/ollamaModelFit.js";

function resolveDefaultOllamaModelId(): string {
  try {
    return getRecommendedQwenModel(bytesToRamGbRounded(os.totalmem()));
  } catch {
    return "qwen3.5:latest";
  }
}

export interface AvailableProvider {
  provider: Provider;
  model: string;
  hasAuth: boolean;
}

/**
 * Get the default provider and model based on what the user has configured.
 * Falls back to OpenAI GPT-5.5 if nothing is configured.
 * 
 * Priority order:
 * 1. OAuth-authenticated providers (openai, anthropic)
 * 2. API key providers (openai, anthropic, google)
 * 3. Ollama (always available, no auth needed)
 * 4. Fallback: openai/gpt-5.5 (will error if not configured)
 */
export async function getDefaultProviderAndModel(): Promise<{
  provider: Provider;
  model: string;
}> {
  const { getProviderAuth, getApiKeys } = await import("./keyResolver.js");

  // Default models for each provider
  const defaultModelByProvider: Record<Provider, string> = {
    openai: "gpt-5.5",
    "openai-codex": "gpt-5.3-codex",
    anthropic: "claude-sonnet-4-6",
    google: "gemini-2.5-flash",
    ollama: resolveDefaultOllamaModelId(),
  };

  try {
    // 1. Check OAuth-authenticated providers first (best UX)
    const openaiAuth = await getProviderAuth("openai");
    if (openaiAuth) {
      return { provider: "openai", model: defaultModelByProvider.openai };
    }

    const anthropicAuth = await getProviderAuth("anthropic");
    if (anthropicAuth) {
      return { provider: "anthropic", model: defaultModelByProvider.anthropic };
    }

    // 2. Check API key providers
    const keys = await getApiKeys([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
    ]);

    if (keys.OPENAI_API_KEY) {
      return { provider: "openai", model: defaultModelByProvider.openai };
    }

    if (keys.ANTHROPIC_API_KEY) {
      return { provider: "anthropic", model: defaultModelByProvider.anthropic };
    }

    if (keys.GOOGLE_API_KEY) {
      return { provider: "google", model: defaultModelByProvider.google };
    }

    // 3. Fallback to Ollama (always available, no auth needed)
    console.log(
      "[DefaultProvider] No OAuth or API keys found, falling back to Ollama (local inference)",
    );
    return { provider: "ollama", model: defaultModelByProvider.ollama };
  } catch (error) {
    // 4. Ultimate fallback: OpenAI (will error if not configured, but that's okay)
    console.warn(
      "[DefaultProvider] Error checking auth, falling back to OpenAI:",
      error,
    );
    return { provider: "openai", model: defaultModelByProvider.openai };
  }
}

/**
 * Get list of all available providers with their authentication status.
 * Useful for Settings UI or diagnostics.
 */
export async function getAvailableProviders(): Promise<AvailableProvider[]> {
  const { getProviderAuth, getApiKeys } = await import("./keyResolver.js");

  const defaultModelByProvider: Record<Provider, string> = {
    openai: "gpt-5.4",
    "openai-codex": "gpt-5.3-codex",
    anthropic: "claude-sonnet-4-6",
    google: "gemini-2.5-flash",
    ollama: resolveDefaultOllamaModelId(),
  };

  const providers: AvailableProvider[] = [];

  try {
    // Check OAuth
    const openaiAuth = await getProviderAuth("openai");
    if (openaiAuth) {
      providers.push({
        provider: "openai",
        model: defaultModelByProvider.openai,
        hasAuth: true,
      });
    }

    const anthropicAuth = await getProviderAuth("anthropic");
    if (anthropicAuth) {
      providers.push({
        provider: "anthropic",
        model: defaultModelByProvider.anthropic,
        hasAuth: true,
      });
    }

    // Check API keys
    const keys = await getApiKeys([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
    ]);

    if (keys.OPENAI_API_KEY && !providers.find((p) => p.provider === "openai")) {
      providers.push({
        provider: "openai",
        model: defaultModelByProvider.openai,
        hasAuth: true,
      });
    }

    if (
      keys.ANTHROPIC_API_KEY &&
      !providers.find((p) => p.provider === "anthropic")
    ) {
      providers.push({
        provider: "anthropic",
        model: defaultModelByProvider.anthropic,
        hasAuth: true,
      });
    }

    if (keys.GOOGLE_API_KEY) {
      providers.push({
        provider: "google",
        model: defaultModelByProvider.google,
        hasAuth: true,
      });
    }

    // Ollama is always available (local inference)
    providers.push({
      provider: "ollama",
      model: defaultModelByProvider.ollama,
      hasAuth: true,
    });
  } catch (error) {
    console.error("[DefaultProvider] Error getting available providers:", error);
  }

  return providers;
}
