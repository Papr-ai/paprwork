/**
 * Client-safe (publishable) credential resolution for mini-app browsers.
 *
 * Keys must be marked clientAccess=client in Settings/vault AND declared in
 * app requirements.json with clientAccess=client.
 */

import type { RequiredKeySpec } from "../types/bundles.js";
import type { KeyClientAccess } from "../types/customKeys.js";
import { DEFAULT_KEY_CLIENT_ACCESS, normalizeKeyClientAccess } from "../types/customKeys.js";
import { normalizeCredentialRequirements } from "./credentialScope.js";

export interface ClientKeyMetadata {
  name: string;
  clientAccess: KeyClientAccess;
}

export function resolveKeyClientAccess(spec: RequiredKeySpec): KeyClientAccess {
  return normalizeKeyClientAccess(spec.clientAccess);
}

export function getClientCredentialKeys(
  requirements: RequiredKeySpec[],
): RequiredKeySpec[] {
  return normalizeCredentialRequirements(requirements).filter(
    (spec) =>
      spec.required !== false && resolveKeyClientAccess(spec) === "client",
  );
}

/** Names allowed for browser fetch — intersection of requirements + optional filter. */
export function getAllowedClientKeyNames(
  requirements: RequiredKeySpec[],
  requestedNames?: string[],
): string[] {
  const allowed = new Set(
    getClientCredentialKeys(requirements).map((spec) => spec.name.trim()),
  );
  if (allowed.size === 0) {
    return [];
  }
  if (!requestedNames?.length) {
    return [...allowed];
  }
  return requestedNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && allowed.has(name));
}

export interface ResolveClientKeysInput {
  requirements: RequiredKeySpec[];
  requestedNames?: string[];
  keyMetadata: ClientKeyMetadata[];
  getValue: (name: string) => Promise<string | null>;
}

export interface ResolveClientKeysResult {
  keys: Record<string, string>;
  missing: string[];
  rejected: string[];
}

/**
 * Resolve publishable keys for mini-app frontend.
 * Rejects keys not declared client in requirements or not marked client in vault.
 */
export async function resolveClientKeys(
  input: ResolveClientKeysInput,
): Promise<ResolveClientKeysResult> {
  const allowedNames = getAllowedClientKeyNames(
    input.requirements,
    input.requestedNames,
  );

  const metadataByName = new Map(
    input.keyMetadata.map((entry) => [
      entry.name.trim().toUpperCase(),
      normalizeKeyClientAccess(entry.clientAccess),
    ]),
  );

  const keys: Record<string, string> = {};
  const missing: string[] = [];
  const rejected: string[] = [];

  for (const name of allowedNames) {
    const vaultAccess =
      metadataByName.get(name.trim().toUpperCase()) ?? DEFAULT_KEY_CLIENT_ACCESS;
    if (vaultAccess !== "client") {
      rejected.push(name);
      continue;
    }
    const value = await input.getValue(name);
    if (!value) {
      missing.push(name);
      continue;
    }
    keys[name] = value;
  }

  return { keys, missing, rejected };
}
