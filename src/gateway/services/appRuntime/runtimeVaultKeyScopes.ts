/**
 * Cloud vault key listing scopes for credential gates (cloud app host).
 *
 * Canonical vault model: one secret per key name with ACL labels.
 * Use scope=context to list all keys the caller may use in org/namespace.
 */

export type RuntimeVaultListScope = "user" | "context";

export interface RuntimeVaultKeyLookup {
  scope: RuntimeVaultListScope;
  query: string;
}

/** Query user-scoped keys; when namespace is known, use context for full ACL union. */
export function runtimeVaultKeyLookupScopes(
  namespaceId: string | undefined,
): RuntimeVaultKeyLookup[] {
  const trimmed = namespaceId?.trim();
  if (trimmed) {
    return [
      {
        scope: "context",
        query: `scope=context&namespace_id=${encodeURIComponent(trimmed)}`,
      },
    ];
  }
  return [{ scope: "user", query: "scope=user" }];
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
