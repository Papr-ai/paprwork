/**
 * Papr service-to-service secrets (memory ↔ gateway ↔ app host).
 *
 * The services read these once at startup and then REMOVE them from
 * process.env, so nothing the service spawns (bash tool, jobs, connectors,
 * app backends) can inherit the service's copy. We filter by source, not by
 * name: a user who stores a vault key under the same name still gets it.
 */

export const SERVICE_SECRET_NAMES = [
  "PAPR_CLOUD_AGENT_GATEWAY_KEY",
  "PAPR_CLOUD_APP_HOST_KEY",
  "PAPR_CLOUD_APP_COOKIE_SECRET",
] as const;

export type ServiceSecretName = (typeof SERVICE_SECRET_NAMES)[number];

const captured = new Map<ServiceSecretName, string>();

/** Call once at service startup, before any agent/job work. Idempotent. */
export function captureServiceSecrets(): void {
  for (const name of SERVICE_SECRET_NAMES) {
    const value = process.env[name]?.trim();
    if (value && !captured.has(name)) captured.set(name, value);
    delete process.env[name];
  }
}

/** Service copy if captured; otherwise process.env (tests / not-yet-captured). */
export function getServiceSecret(name: ServiceSecretName): string | undefined {
  return captured.get(name) ?? (process.env[name]?.trim() || undefined);
}

/**
 * For Papr's OWN internal worker processes (publish / background / replica
 * workers) that are part of the service, not user code.
 */
export function serviceSecretsEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of captured) out[name] = value;
  return out;
}

/** Test helper. */
export function resetServiceSecretsForTests(): void {
  captured.clear();
}
