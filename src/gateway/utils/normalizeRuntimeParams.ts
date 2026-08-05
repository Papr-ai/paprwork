/**
 * Normalize mini-app / API runtime param keys to job env conventions (UPPER_SNAKE).
 * Apps often send audit_id; job prompts expect AUDIT_ID in bash.
 */

export function normalizeRuntimeParamKey(key: string): string {
  if (key === "prompt") {
    return key;
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return key;
  }
  return key.toUpperCase().replace(/-/g, "_");
}

export function normalizeRuntimeParams(
  params: Record<string, string> | undefined,
): Record<string, string> {
  if (!params) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[normalizeRuntimeParamKey(key)] = value;
  }
  return normalized;
}

export function runtimeParamsForJobEnv(
  params: Record<string, string> | undefined,
): Record<string, string> {
  const normalized = normalizeRuntimeParams(params);
  const { prompt: _prompt, ...env } = normalized;
  return env;
}
