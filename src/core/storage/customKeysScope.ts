/** Session/auth keys shared across all organizations on this machine. */
export const GLOBAL_CUSTOM_KEY_NAMES = new Set<string>([
  "PAPR_SESSION_TOKEN",
  "PAPR_REFRESH_TOKEN",
  "PAPR_ACCESS_TOKEN",
]);

export function isGlobalCustomKeyName(name: string): boolean {
  return GLOBAL_CUSTOM_KEY_NAMES.has(name.trim().toUpperCase());
}
