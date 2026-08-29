/**
 * LLM API keys for embedded app-agent chat — surfaced in requirements.json catalog.
 */

import type { Provider } from "../types/agents.js";
import type { RequiredKeySpec } from "../types/bundles.js";

/** Env var names used by cloud agent gateway for each LLM provider. */
export const PROVIDER_LLM_ENV_KEYS: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

const LLM_ENV_KEY_SET = new Set(Object.values(PROVIDER_LLM_ENV_KEYS));

export function llmEnvKeyForProvider(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return PROVIDER_LLM_ENV_KEYS[normalized] ?? null;
}

export function isLlmEnvKeyName(name: string): boolean {
  return LLM_ENV_KEY_SET.has(name.trim());
}

function inferServiceLabel(keyName: string): string {
  const base = keyName.replace(/_API_KEY$/i, "").replace(/_/g, " ").trim();
  if (!base) {
    return keyName;
  }
  return base
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** Default catalog row for embedded chat / sub-agent LLM billing. */
export function buildAgentChatLlmRequirement(keyName: string): RequiredKeySpec {
  const trimmed = keyName.trim();
  return {
    name: trimmed,
    service: inferServiceLabel(trimmed),
    category: "ai",
    description:
      "LLM credentials for embedded app assistant chat and sub-agent runs on published apps",
    required: true,
    credentialScope: "owner",
    clientAccess: "server",
  };
}

/** Merge LLM env keys into requirements; preserve existing rows (including scope). */
export function mergeAgentChatLlmKeysIntoRequirements(
  requirements: RequiredKeySpec[],
  keyNames: readonly string[],
): RequiredKeySpec[] {
  const byName = new Map(requirements.map((spec) => [spec.name, spec]));
  for (const rawName of keyNames) {
    const name = rawName.trim();
    if (!name || byName.has(name)) {
      continue;
    }
    byName.set(name, buildAgentChatLlmRequirement(name));
  }
  return [...byName.values()];
}

/** Collect unique LLM env keys for sub-agent primary + fallback providers. */
export function collectLlmEnvKeysForProviders(
  providers: readonly (Provider | string | undefined)[],
): string[] {
  const names = new Set<string>();
  for (const provider of providers) {
    if (!provider || typeof provider !== "string") {
      continue;
    }
    const keyName = llmEnvKeyForProvider(provider);
    if (keyName) {
      names.add(keyName);
    }
  }
  return [...names].sort();
}
