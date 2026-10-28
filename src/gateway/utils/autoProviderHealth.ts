/**
 * Providers an Auto turn found unusable in practice: credentials existed, but
 * the provider refused them (e.g. the Papr AI proxy's own Anthropic key was
 * revoked, so every proxied Claude call returns 401).
 *
 * findReachableProvider only checks that a credential exists, and the proxy
 * counts as a credential for every provider, so it cannot see this. Auto
 * records the refusal here and skips that provider until credentials change
 * (the auth epoch moves), so later turns don't hit the same wall.
 */

import type { Provider } from "../../core/types/index.js";
import { getAuthEpoch } from "./keyResolver.js";

let epoch = -1;
const refused = new Set<Provider>();

function current(): Set<Provider> {
  const now = getAuthEpoch();
  if (now !== epoch) {
    epoch = now;
    refused.clear();
  }
  return refused;
}

export function markAutoProviderRefused(provider: Provider): void {
  current().add(provider === "openai-codex" ? "openai" : provider);
}

export function autoRefusedProviders(): Provider[] {
  return [...current()];
}

/** A provider rejecting the credential itself, not a quota, outage or bad request. */
export function isProviderAuthError(text: string): boolean {
  if (/rate.?limit|quota|credit balance|usage limit|overloaded/i.test(text)) return false;
  return /authentication_error|invalid x-api-key|invalid api key|incorrect api key|api_key_invalid|api key not valid|unauthenticated|permission_denied|\b401\b|unauthorized/i.test(
    text,
  );
}
