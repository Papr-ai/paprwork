/**
 * Custom API key visibility for mini-app clients.
 *
 * - server: vault/backend/jobs only (default) — never returned to browser
 * - client: publishable keys safe for mini-app frontend fetch()
 */

export type KeyClientAccess = "server" | "client";

export const DEFAULT_KEY_CLIENT_ACCESS: KeyClientAccess = "server";

export function isKeyClientAccess(value: unknown): value is KeyClientAccess {
  return value === "server" || value === "client";
}

export function normalizeKeyClientAccess(value: unknown): KeyClientAccess {
  return isKeyClientAccess(value) ? value : DEFAULT_KEY_CLIENT_ACCESS;
}
