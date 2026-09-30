import {
  extractChatGptAccountIdFromToken,
  normalizeChatGptOAuthToken,
} from "../../utils/resolveJobProviderModel.js";
import {
  getApiKeys,
  getOAuthToken,
  hasValidOAuthToken,
} from "../../utils/keyResolver.js";

export type MediaAuthKind = "google_api_key" | "openai_platform" | "openai_oauth";

export interface MediaAuthContext {
  googleApiKey?: string;
  openaiPlatformKey?: string;
  openaiOAuth?: {
    token: string;
    accountId: string;
  };
}

const GOOGLE_KEY_NAMES = ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;

function isOAuthShapedOpenAiKey(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("sk-ant-oat") ||
    trimmed.startsWith("sk-ant-ort") ||
    trimmed.startsWith("sk-oat") ||
    (trimmed.includes("eyJ") && trimmed.split(".").length >= 3)
  );
}

async function ensureOAuthCacheLoaded(): Promise<void> {
  await getApiKeys(["OPENAI_API_KEY"]);
}

export async function loadMediaAuthContext(): Promise<MediaAuthContext> {
  await ensureOAuthCacheLoaded();

  const keys = await getApiKeys([
    ...GOOGLE_KEY_NAMES,
    "OPENAI_API_KEY",
  ]);

  const googleApiKey =
    keys.GOOGLE_API_KEY?.trim() || keys.GOOGLE_GENERATIVE_AI_API_KEY?.trim();

  let openaiPlatformKey: string | undefined;
  const rawOpenAi = keys.OPENAI_API_KEY?.trim();
  if (rawOpenAi && !isOAuthShapedOpenAiKey(rawOpenAi)) {
    openaiPlatformKey = rawOpenAi;
  }

  let openaiOAuth: MediaAuthContext["openaiOAuth"];
  if (hasValidOAuthToken("openai")) {
    const tokenRecord = getOAuthToken("openai");
    const token = tokenRecord?.accessToken?.trim();
    if (token) {
      const normalized = normalizeChatGptOAuthToken(token);
      const accountId = extractChatGptAccountIdFromToken(normalized);
      if (accountId) {
        openaiOAuth = { token: normalized, accountId };
      }
    }
  }

  return {
    googleApiKey: googleApiKey || undefined,
    openaiPlatformKey,
    openaiOAuth,
  };
}

export function describeOpenAiMediaAuth(ctx: MediaAuthContext): string {
  if (ctx.openaiOAuth) {
    return "ChatGPT OAuth (Codex image_generation)";
  }
  if (ctx.openaiPlatformKey) {
    return "OpenAI Platform API key";
  }
  return "missing OPENAI_API_KEY or ChatGPT OAuth";
}
