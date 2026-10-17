/**
 * Environment for processes we spawn on behalf of agents, jobs and app
 * backends (bash tool, command jobs, connectors, Python app workers).
 *
 * Platform service secrets live in the gateway / app-host process env so the
 * service can authenticate to memory and to each other. User code must never
 * inherit them: on the cloud agent gateway a `bash env` would otherwise print
 * the shared keys that let a caller impersonate memory.
 *
 * Vault keys, PAPR_API_KEY, APP_DB / JOB_DB and Turso settings are unaffected.
 */

/** Papr service-to-service keys: never passed to child processes, anywhere. */
export const PLATFORM_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "PAPR_CLOUD_AGENT_GATEWAY_KEY",
  "PAPR_CLOUD_APP_HOST_KEY",
]);

/**
 * Only stripped on Papr Cloud services. On desktop these belong to the user
 * (their own Google SDK / GitHub App scripts) and must keep working.
 */
export const CLOUD_ONLY_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "GITHUB_APP_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

/** Running as a Papr Cloud service (agent gateway, app host, repo writer). */
export function isPaprCloudService(): boolean {
  return process.env.GATEWAY_MODE === "cloud_agent" || Boolean(process.env.K_SERVICE);
}

export function isPlatformSecretEnvKey(name: string): boolean {
  return (
    PLATFORM_SECRET_ENV_KEYS.has(name) ||
    (isPaprCloudService() && CLOUD_ONLY_SECRET_ENV_KEYS.has(name))
  );
}

/** process.env (+ extra) minus platform service secrets. */
export function childProcessEnv(
  extra?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  for (const key of Object.keys(env)) {
    if (isPlatformSecretEnvKey(key)) delete env[key];
  }
  return env;
}
