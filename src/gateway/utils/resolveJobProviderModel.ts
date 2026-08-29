/**
 * Resolve provider + model for agent jobs (local and cloud).
 * Uses vault/env keys on cloud; IPC/keychain locally.
 */

import type { Provider } from "../../core/types/index.js";
import { reconcileCloudProviderAuth } from "../services/cloudAgentGateway/resolveCloudProviderAuth.js";
import { normalizeOpenAIModelId } from "./modelNormalizer.js";

export const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
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

function isCloudAgentGateway(): boolean {
  return process.env.GATEWAY_MODE === "cloud_agent";
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CloudAgentCredentials {
  provider: Provider;
  model: string;
  token: string;
  authType: "oauth" | "apiKey";
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const JWT_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Returns true when JWT exp claim is missing or past (with buffer). */
export function isJwtExpired(token: string): boolean {
  const payload = decodeJwtPayload(normalizeChatGptOAuthToken(token));
  if (!payload) return true;
  const exp = payload.exp;
  if (typeof exp !== "number") return false;
  return Date.now() >= exp * 1000 - JWT_EXPIRY_BUFFER_MS;
}

/** ChatGPT OAuth tokens must carry chatgpt_account_id for pi-ai Codex routes. */
export function normalizeChatGptOAuthToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.split(".").length === 3) {
    return trimmed;
  }

  const jwtMatch = trimmed.match(
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  );
  return jwtMatch?.[0] ?? trimmed;
}

export function extractChatGptAccountIdFromToken(token: string): string | undefined {
  const normalized = normalizeChatGptOAuthToken(token);
  const payload = decodeJwtPayload(normalized);
  if (!payload) return undefined;
  const auth = payload[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: string }
    | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : undefined;
}

/** Classify OpenAI vault key — null means unusable for cloud agent runs. */
export function resolveOpenAIKeyAuthType(
  token: string,
): "oauth" | "apiKey" | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const normalized = normalizeChatGptOAuthToken(trimmed);
  const accountId = extractChatGptAccountIdFromToken(normalized);
  if (accountId) {
    if (isJwtExpired(normalized)) {
      console.warn(
        "[ResolveJobProviderModel] OpenAI OAuth token expired — skipping",
      );
      return null;
    }
    return "oauth";
  }

  const oauthShaped =
    trimmed.startsWith("sk-oat") ||
    trimmed.includes("eyJ") ||
    normalized.split(".").length === 3;
  if (oauthShaped) {
    return null;
  }

  if (trimmed.startsWith("sk-proj-") || trimmed.startsWith("sk-")) {
    return "apiKey";
  }

  return null;
}

function tryOpenAICredentials(
  openaiKey: string,
  model?: string,
): CloudAgentCredentials | null {
  const authType = resolveOpenAIKeyAuthType(openaiKey);
  if (!authType) {
    console.warn(
      "[ResolveJobProviderModel] OPENAI_API_KEY looks like OAuth but missing chatgpt_account_id — skipping",
    );
    return null;
  }

  const resolvedModel = normalizeModelForProvider(
    "openai",
    model ?? DEFAULT_MODEL_BY_PROVIDER.openai,
  );

  return {
    provider: "openai",
    model: resolvedModel,
    token: normalizeChatGptOAuthToken(openaiKey),
    authType,
  };
}

function tryAnthropicCredentials(
  anthropicKey: string,
  model?: string,
): CloudAgentCredentials | null {
  if (!anthropicKey) return null;

  const authType: "oauth" | "apiKey" = anthropicKey.startsWith("sk-ant-oat")
    ? "oauth"
    : "apiKey";

  return {
    provider: "anthropic",
    model: model ?? DEFAULT_MODEL_BY_PROVIDER.anthropic,
    token: anthropicKey,
    authType,
  };
}

function tryGoogleCredentials(
  googleKey: string,
  model?: string,
): CloudAgentCredentials | null {
  if (!googleKey) return null;

  return {
    provider: "google",
    model: model ?? DEFAULT_MODEL_BY_PROVIDER.google,
    token: googleKey,
    authType: "apiKey",
  };
}

function tryProviderCredentials(
  provider: Provider,
  keys: {
    openaiKey: string;
    anthropicKey: string;
    googleKey: string;
  },
  model?: string,
): CloudAgentCredentials | null {
  switch (provider) {
    case "openai":
    case "openai-codex":
      return tryOpenAICredentials(keys.openaiKey, model);
    case "anthropic":
      return tryAnthropicCredentials(keys.anthropicKey, model);
    case "google":
      return tryGoogleCredentials(keys.googleKey, model);
    default:
      return null;
  }
}

/**
 * Pick the first provider with usable vault credentials.
 * Validates ChatGPT OAuth tokens (accountId required) before selecting OpenAI.
 */
export function resolveUsableCloudCredentials(input?: {
  preferredProvider?: Provider;
  model?: string;
}): CloudAgentCredentials | null {
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ?? "";
  const keys = { openaiKey, anthropicKey, googleKey };

  const priority: Provider[] = ["openai", "anthropic", "google"];
  const tryOrder = input?.preferredProvider
    ? [
        input.preferredProvider,
        ...priority.filter((provider) => provider !== input.preferredProvider),
      ]
    : priority;

  for (const provider of tryOrder) {
    const credentials = tryProviderCredentials(provider, keys, input?.model);
    if (credentials) {
      if (
        input?.preferredProvider &&
        provider !== input.preferredProvider
      ) {
        console.warn(
          `[ResolveJobProviderModel] Provider fallback: ${input.preferredProvider} → ${provider}`,
        );
      }
      return credentials;
    }
  }

  return null;
}

/**
 * Pick best provider/model from vault keys already injected into process.env.
 * Priority mirrors desktop: OpenAI OAuth → Anthropic OAuth → API keys → Google.
 */
export function resolveDefaultProviderFromVaultEnv(): {
  provider: Provider;
  model: string;
} {
  const credentials = resolveUsableCloudCredentials();
  if (credentials) {
    return {
      provider: credentials.provider,
      model: credentials.model,
    };
  }

  throw new Error(
    "No usable LLM credentials in vault env for cloud agent run (check OpenAI/Anthropic/Google keys)",
  );
}

function normalizeModelForProvider(provider: Provider, model: string): string {
  if (provider === "openai" || provider === "openai-codex") {
    return normalizeOpenAIModelId(model);
  }
  return model;
}

/**
 * Resolve provider/model for an agent job session.
 * When the job omits provider/model, picks what the user actually has configured.
 */
export async function resolveJobProviderModel(input: {
  provider?: Provider;
  model?: string;
}): Promise<{ provider: Provider; model: string }> {
  let provider = input.provider;
  let model = input.model;

  if (!provider) {
    if (isCloudAgentGateway()) {
      const cloudDefaults = resolveDefaultProviderFromVaultEnv();
      provider = cloudDefaults.provider;
      model = model ?? cloudDefaults.model;
      console.log(
        `[ResolveJobProviderModel] Cloud vault defaults: ${provider}/${model}`,
      );
    } else {
      const { getDefaultProviderAndModel } = await import("./defaultProvider.js");
      const defaults = await getDefaultProviderAndModel();
      provider = defaults.provider;
      model = model ?? defaults.model;
      console.log(
        `[ResolveJobProviderModel] Local defaults: ${provider}/${model}`,
      );
    }
  }

  provider = provider as Provider;
  model =
    model ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL_BY_PROVIDER.openai;

  model = normalizeModelForProvider(provider, model);

  return { provider, model };
}

/**
 * Cloud gateway: resolve provider/model + validated auth from injected vault env.
 * Falls back across providers when preferred credentials are unusable.
 */
export async function resolveCloudAgentJobSession(input: {
  provider?: Provider;
  model?: string;
}): Promise<CloudAgentCredentials> {
  const credentials = resolveUsableCloudCredentials({
    preferredProvider: input.provider,
    model: input.model,
  });

  if (!credentials) {
    throw new Error(
      "No usable LLM credentials in vault for cloud agent run (check OpenAI/Anthropic/Google keys)",
    );
  }

  console.log(
    `[ResolveJobProviderModel] Cloud session: ${credentials.provider}/${credentials.model} authType=${credentials.authType}`,
  );

  return credentials;
}

/**
 * Cloud gateway: resolve provider/model using memory-server authOverride token.
 * Vault env is used only for provider/model defaults — never overwrites the token.
 */
export async function resolveCloudAgentJobSessionFromAuthOverride(input: {
  provider?: Provider;
  model?: string;
  token: string;
  authType: "oauth" | "apiKey";
}): Promise<CloudAgentCredentials> {
  const resolved = await resolveJobProviderModel({
    provider: input.provider,
    model: input.model,
  });

  const llmAuth = reconcileCloudProviderAuth({
    provider: resolved.provider,
    token: input.token,
    authType: input.authType,
  });

  console.log(
    `[ResolveJobProviderModel] Cloud session (authOverride): ${resolved.provider}/${resolved.model} authType=${llmAuth.authType}`,
  );

  return {
    provider: resolved.provider,
    model: resolved.model,
    token: llmAuth.token,
    authType: llmAuth.authType,
  };
}
