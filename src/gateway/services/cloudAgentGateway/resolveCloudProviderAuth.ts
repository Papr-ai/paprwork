import type { Provider } from "../../../core/types/agents.js";
import type { CloudProviderAuthResolution } from "./types.js";

const OAUTH_KEY_DESCRIPTION_MARKERS = ["oauth token", "oauth", "auto-managed"];

const PROVIDER_KEY_NAMES: Partial<Record<Provider, string>> = {
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export interface VaultKeySourceMeta {
  name: string;
  source?: string;
  managedBy?: string;
  oauthProvider?: string;
  description?: string;
}

function looksLikeOAuthTokenPrefix(keyName: string, token: string): boolean {
  if (keyName !== "OPENAI_API_KEY" && keyName !== "ANTHROPIC_API_KEY") {
    return false;
  }
  return token.startsWith("sk-ant-oat") || token.startsWith("sk-oat");
}

/** Infer vault papr-source label from key metadata, falling back to token shape. */
export function resolveVaultKeySource(
  meta: VaultKeySourceMeta,
  value: string,
): string {
  if (
    meta.source === "oauth" ||
    meta.managedBy === "oauth" ||
    meta.oauthProvider
  ) {
    return "oauth";
  }

  const description = meta.description?.toLowerCase() ?? "";
  if (OAUTH_KEY_DESCRIPTION_MARKERS.some((marker) => description.includes(marker))) {
    return "oauth";
  }

  if (looksLikeOAuthTokenPrefix(meta.name, value)) {
    return "oauth";
  }

  if (meta.name.toLowerCase().includes("oauth")) {
    return "oauth";
  }

  return "manual";
}

export function resolveCloudProviderAuthFromVaultKeys(input: {
  provider: Provider;
  keys: Record<string, string>;
  keyMetadata?: Record<string, { source?: string; description?: string }>;
}): CloudProviderAuthResolution | null {
  const keyName = PROVIDER_KEY_NAMES[input.provider];
  if (!keyName) {
    return null;
  }

  const token = input.keys[keyName]?.trim();
  if (!token) {
    return null;
  }

  const meta = input.keyMetadata?.[keyName];
  if (meta?.source === "oauth") {
    return { provider: input.provider, authType: "oauth", token };
  }

  const description = meta?.description?.toLowerCase() ?? "";
  if (OAUTH_KEY_DESCRIPTION_MARKERS.some((marker) => description.includes(marker))) {
    return { provider: input.provider, authType: "oauth", token };
  }

  if (looksLikeOAuthTokenPrefix(keyName, token)) {
    return { provider: input.provider, authType: "oauth", token };
  }

  return { provider: input.provider, authType: "apiKey", token };
}

/** Reconcile when memory server sent wrong authType — only upgrade on explicit oauth signals. */
export function reconcileCloudProviderAuth(input: {
  provider: Provider;
  token: string;
  authType: "oauth" | "apiKey";
}): CloudProviderAuthResolution {
  const token = input.token.trim();
  const keyName = PROVIDER_KEY_NAMES[input.provider];

  if (
    input.provider === "openai" &&
    input.authType === "oauth" &&
    keyName === "OPENAI_API_KEY" &&
    looksLikeOAuthTokenPrefix(keyName, token)
  ) {
    const payload = token.split(".");
    if (payload.length === 3) {
      try {
        const decoded = Buffer.from(payload[1] ?? "", "base64url").toString(
          "utf-8",
        );
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        const auth = parsed["https://api.openai.com/auth"] as
          | { chatgpt_account_id?: string }
          | undefined;
        if (!auth?.chatgpt_account_id) {
          console.warn(
            "[CloudAgentAuth] OpenAI OAuth token missing chatgpt_account_id — treating as apiKey",
          );
          return { provider: input.provider, authType: "apiKey", token };
        }
      } catch {
        console.warn(
          "[CloudAgentAuth] OpenAI OAuth token is not a valid JWT — treating as apiKey",
        );
        return { provider: input.provider, authType: "apiKey", token };
      }
    }
  }

  if (input.authType === "oauth") {
    return { provider: input.provider, authType: "oauth", token };
  }

  if (keyName && looksLikeOAuthTokenPrefix(keyName, token)) {
    console.warn(
      `[CloudAgentAuth] Correcting authType apiKey → oauth for ${input.provider} ` +
        `(${keyName}, sk-oat prefix)`,
    );
    return { provider: input.provider, authType: "oauth", token };
  }

  return { provider: input.provider, authType: input.authType, token };
}
