/**
 * Per-key credential scope for shared cloud apps.
 *
 * - owner: publisher's vault keys (live web + sandbox jobs run as publisher)
 * - user:  each signed-in visitor/installer must provide their own keys
 */

import type { RequiredKeySpec } from "../types/bundles.js";
import { normalizeRequirements } from "../types/bundles.js";

export type CredentialScope = "owner" | "user";

export const DEFAULT_CREDENTIAL_SCOPE: CredentialScope = "user";

export function resolveCredentialScope(spec: RequiredKeySpec): CredentialScope {
  return spec.credentialScope === "owner" ? "owner" : "user";
}

export function normalizeCredentialRequirements(
  items: RequiredKeySpec[],
): RequiredKeySpec[] {
  return normalizeRequirements(items).map((spec) => ({
    ...spec,
    credentialScope: resolveCredentialScope(spec),
  }));
}

export function getOwnerCredentialKeys(
  requirements: RequiredKeySpec[],
): RequiredKeySpec[] {
  return normalizeCredentialRequirements(requirements).filter(
    (spec) => spec.required !== false && resolveCredentialScope(spec) === "owner",
  );
}

export function getUserCredentialKeys(
  requirements: RequiredKeySpec[],
): RequiredKeySpec[] {
  return normalizeCredentialRequirements(requirements).filter(
    (spec) => spec.required !== false && resolveCredentialScope(spec) === "user",
  );
}

/** True when visitors must sign in with Papr (even on public / invite links). */
export function appRequiresUserSignIn(requirements: RequiredKeySpec[]): boolean {
  return getUserCredentialKeys(requirements).length > 0;
}

export function getMissingUserKeyNames(
  requirements: RequiredKeySpec[],
  vaultKeyNames: ReadonlySet<string> | readonly string[],
): string[] {
  const present = vaultKeyNames instanceof Set
    ? vaultKeyNames
    : new Set(vaultKeyNames);
  return getUserCredentialKeys(requirements)
    .map((spec) => spec.name)
    .filter((name) => !present.has(name));
}

export function userCredentialsReady(
  requirements: RequiredKeySpec[],
  vaultKeyNames: ReadonlySet<string> | readonly string[],
): boolean {
  return getMissingUserKeyNames(requirements, vaultKeyNames).length === 0;
}
