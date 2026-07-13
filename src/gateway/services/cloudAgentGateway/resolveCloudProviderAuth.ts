import type { Provider } from "../../../core/types/agents.js";
import type { CloudProviderAuthResolution } from "./types.js";

const OAUTH_KEY_DESCRIPTION_MARKERS = ["oauth token", "oauth", "auto-managed"];

export function resolveCloudProviderAuthFromVaultKeys(input: {
  provider: Provider;
  keys: Record<string, string>;
  keyMetadata?: Record<string, { source?: string; description?: string }>;
}): CloudProviderAuthResolution | null {
  const keyName =
    input.provider === "openai" || input.provider === "openai-codex"
      ? "OPENAI_API_KEY"
      : input.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : input.provider === "google"
          ? "GOOGLE_GENERATIVE_AI_API_KEY"
          : null;

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

  if (token.startsWith("sk-ant-oat") || token.startsWith("sk-oat")) {
    return { provider: input.provider, authType: "oauth", token };
  }

  return { provider: input.provider, authType: "apiKey", token };
}
