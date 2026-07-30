import { isInternalPaprNamespaceApiKeyName } from "../utils/paprApiKey.js";

/** Session/auth keys shared across all organizations on this machine. */
export const GLOBAL_CUSTOM_KEY_NAMES = new Set<string>([
  "PAPR_SESSION_TOKEN",
  "PAPR_REFRESH_TOKEN",
  "PAPR_ACCESS_TOKEN",
]);

export function isGlobalCustomKeyName(name: string): boolean {
  return GLOBAL_CUSTOM_KEY_NAMES.has(name.trim().toUpperCase());
}

/** Papr platform API keys — always stored in the active org vault, never shared. */
export function isPaprPlatformApiKeyName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  return (
    normalized === "PAPR_API_KEY" || isInternalPaprNamespaceApiKeyName(normalized)
  );
}
