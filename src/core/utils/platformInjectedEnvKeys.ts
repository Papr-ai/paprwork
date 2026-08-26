/**
 * Env vars injected by Papr at runtime — not Settings vault keys or requirements.json entries.
 */

export const VERIFIED_CALLER_USER_ID_ENV = "PAPR_CALLER_USER_ID";
export const VERIFIED_CALLER_EMAIL_ENV = "PAPR_CALLER_EMAIL";

const PLATFORM_INJECTED_ENV_KEYS = new Set<string>([
  VERIFIED_CALLER_USER_ID_ENV,
  VERIFIED_CALLER_EMAIL_ENV,
]);

/** True when the name is server-injected identity (PAPR_CALLER_*), not a vault key. */
export function isPlatformInjectedEnvKey(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  if (PLATFORM_INJECTED_ENV_KEYS.has(trimmed)) {
    return true;
  }
  return trimmed.startsWith("PAPR_CALLER_");
}

/** Drop platform-injected env names from vault key lists. */
export function filterVaultKeyNames(names: readonly string[]): string[] {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !isPlatformInjectedEnvKey(name));
}
