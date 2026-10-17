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

/** Exact names never passed to child processes. */
export const PLATFORM_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "PAPR_CLOUD_AGENT_GATEWAY_KEY",
  "PAPR_CLOUD_APP_HOST_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

export function isPlatformSecretEnvKey(name: string): boolean {
  return PLATFORM_SECRET_ENV_KEYS.has(name);
}

/** process.env (+ extra) minus platform service secrets. */
export function childProcessEnv(
  extra?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  for (const key of PLATFORM_SECRET_ENV_KEYS) delete env[key];
  return env;
}
