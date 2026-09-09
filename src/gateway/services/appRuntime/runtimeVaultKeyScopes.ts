/**
 * Cloud vault key listing scopes for credential gates.
 *
 * - user: caller's private keys ("Only me" in Integration Keys)
 * - namespace: team-shared keys for the active namespace ("Team")
 */

export type RuntimeVaultListScope = "user" | "namespace";

export interface RuntimeVaultKeyLookup {
  scope: RuntimeVaultListScope;
  query: string;
}

/** Query user-scoped keys always; add namespace when the app has a namespace id. */
export function runtimeVaultKeyLookupScopes(
  namespaceId: string | undefined,
): RuntimeVaultKeyLookup[] {
  const trimmed = namespaceId?.trim();
  const userQuery = trimmed
    ? `scope=user&namespace_id=${encodeURIComponent(trimmed)}`
    : "scope=user";
  const lookups: RuntimeVaultKeyLookup[] = [
    { scope: "user", query: userQuery },
  ];
  if (trimmed) {
    lookups.push({
      scope: "namespace",
      query: `scope=namespace&namespace_id=${encodeURIComponent(trimmed)}`,
    });
  }
  return lookups;
}

export function mergeRuntimeVaultKeyNames(
  ...lists: ReadonlyArray<readonly string[]>
): string[] {
  const names = new Set<string>();
  for (const list of lists) {
    for (const name of list) {
      const trimmed = name.trim();
      if (trimmed.length > 0) {
        names.add(trimmed);
      }
    }
  }
  return [...names];
}
