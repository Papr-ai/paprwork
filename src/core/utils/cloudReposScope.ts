/**
 * Cloud git repo + vault scope helpers for memory server APIs.
 */

import { readActiveWorkspacePointer } from "./paprWorkspace.js";

export type CloudRepoScope = "user" | "namespace" | "org";

export interface CloudReposRequestBody {
  scope: CloudRepoScope;
  namespace_id?: string;
  template?: "default";
}

export function buildCloudReposRequestBody(
  scope: CloudRepoScope = "user",
): CloudReposRequestBody {
  const pointer = readActiveWorkspacePointer();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
  return {
    scope,
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    ...(scope === "user" ? { template: "default" as const } : {}),
  };
}

export function buildCloudVaultRequestBody(
  keys: unknown,
  scope: CloudRepoScope = "namespace",
): { scope: CloudRepoScope; namespace_id?: string; keys: unknown } {
  const pointer = readActiveWorkspacePointer();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
  return {
    scope,
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    keys,
  };
}
