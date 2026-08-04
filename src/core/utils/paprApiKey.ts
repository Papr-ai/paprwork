/**
 * Papr API key scope helpers — shared by Electron main, gateway, and IPC.
 */

import { readActiveWorkspacePointer } from "./paprWorkspace.js";

/** True when an API key belongs to the given org + namespace pair. */
export function paprApiKeyMatchesNamespace(
  apiKey: string,
  organizationId: string,
  namespaceId: string,
  options?: { trustLegacyBinding?: boolean },
): boolean {
  const trimmed = apiKey.trim();
  const prefix = `sk-org-${organizationId}-namespace-${namespaceId}-`;
  if (trimmed.startsWith(prefix)) {
    return true;
  }

  const scope = parsePaprApiKeyScope(trimmed);
  if (!scope) {
    // Legacy keys omit embedded namespace. Trust only when the caller bound the
    // key to this namespace (vault slot PAPR_API_KEY__{id} or GraphQL filtered by namespaceId).
    return options?.trustLegacyBinding === true;
  }

  // Namespace is the hard binding for Papr API keys. Org id in the key string can
  // differ from the active workspace pointer when Parse org vs workspace ids diverge.
  return scope.namespaceId === namespaceId;
}

/**
 * Validate a key resolved from a namespace-bound source (vault slot or GraphQL
 * query filtered by namespaceId). Legacy keys without embedded namespace are accepted.
 */
export function paprApiKeyMatchesNamespaceBound(
  apiKey: string,
  organizationId: string,
  namespaceId: string,
): boolean {
  return paprApiKeyMatchesNamespace(apiKey, organizationId, namespaceId, {
    trustLegacyBinding: true,
  });
}

/** Parse org + namespace embedded in a Papr API key, when present. */
export function parsePaprApiKeyScope(
  apiKey: string,
): { organizationId: string; namespaceId: string } | null {
  const match = apiKey.match(/^sk-org-([^-]+)-namespace-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  return { organizationId: match[1], namespaceId: match[2] };
}

/** Active workspace pointer from gateway env (set by Electron on namespace switch). */
export function getActivePaprWorkspacePointer(): {
  organizationId: string;
  namespaceId: string;
} | null {
  const organizationId = process.env.PAPR_ORG_ID?.trim();
  const namespaceId = process.env.PAPR_NAMESPACE_ID?.trim();
  if (!organizationId || !namespaceId) return null;
  return { organizationId, namespaceId };
}

/** True when the requested namespace is the active workspace. */
export function isActivePaprNamespace(namespaceId: string): boolean {
  const pointer = getActivePaprWorkspacePointer();
  return pointer?.namespaceId === namespaceId.trim();
}

/** Env fallback is only valid when it matches the active workspace pointer. */
export function paprApiKeyMatchesActiveWorkspace(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  const pointer =
    getActivePaprWorkspacePointer() ?? readActiveWorkspacePointer();
  if (!pointer) {
    // No workspace selected yet (first launch before namespace pick).
    return true;
  }

  // Untrusted sources (.env, generic PAPR_API_KEY alias) must be parseable.
  const scope = parsePaprApiKeyScope(trimmed);
  if (!scope) {
    return false;
  }

  return paprApiKeyMatchesNamespace(
    trimmed,
    pointer.organizationId,
    pointer.namespaceId,
  );
}

/** Internal vault slot for a namespace-scoped Papr API key (not shown in Settings). */
export function paprNamespaceApiKeyName(namespaceId: string): string {
  const trimmed = namespaceId.trim();
  if (!trimmed) {
    throw new Error("namespaceId is required for Papr namespace API key storage");
  }
  return `PAPR_API_KEY__${trimmed}`;
}

export function isInternalPaprNamespaceApiKeyName(name: string): boolean {
  return name.trim().toUpperCase().startsWith("PAPR_API_KEY__");
}
