/**
 * Papr Memory ACL helpers.
 *
 * Paprwork users ARE real Papr accounts, so we send Parse _User.objectId as
 * `user_id` (not `external_user_id`). Sending it as external_user_id makes the
 * memory server mint an anonymous shadow DeveloperUser, which splits one human
 * into several identities and breaks feedback authorization.
 *
 * ACL principals therefore use the `user:{objectId}` prefix, which maps to
 * user_read_access / user_write_access — the fields the search filter actually
 * evaluates. `external_user:` maps to external_user_read_access, which is NOT
 * part of the ACL OR-branch (that filter is commented out server-side).
 *
 * `external_user_id` remains supported by the memory server for third-party SDK
 * developers whose end users have no Papr account. It is not used by Paprwork.
 */

import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";

export const USER_PRINCIPAL_PREFIX = "user:" as const;
export const EXTERNAL_USER_PRINCIPAL_PREFIX = "external_user:" as const;
export const NAMESPACE_PRINCIPAL_PREFIX = "namespace:" as const;
export const ORGANIZATION_PRINCIPAL_PREFIX = "organization:" as const;

const PRINCIPAL_PATTERN =
  /^(user|external_user|namespace|organization):[A-Za-z0-9_-]+$/;

/** Strip a `user:` / `external_user:` prefix if a full principal was pasted. */
export function normalizeExternalUserId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(EXTERNAL_USER_PRINCIPAL_PREFIX)) {
    return trimmed.slice(EXTERNAL_USER_PRINCIPAL_PREFIX.length).trim();
  }
  if (trimmed.startsWith(USER_PRINCIPAL_PREFIX)) {
    return trimmed.slice(USER_PRINCIPAL_PREFIX.length).trim();
  }
  return trimmed;
}

/**
 * Build a `user:{objectId}` principal for a real Papr account.
 * Accepts a bare objectId or an already-prefixed principal.
 */
export function toUserPrincipal(userId: string): string {
  const id = normalizeExternalUserId(userId);
  if (!id) {
    throw new Error("user id must be non-empty");
  }
  return `${USER_PRINCIPAL_PREFIX}${id}`;
}

/**
 * Build an `external_user:{id}` principal.
 * Retained for third-party SDK end users; Paprwork uses toUserPrincipal.
 */
export function toExternalUserPrincipal(externalUserId: string): string {
  const id = normalizeExternalUserId(externalUserId);
  if (!id) {
    throw new Error("external user id must be non-empty");
  }
  return `${EXTERNAL_USER_PRINCIPAL_PREFIX}${id}`;
}

export function toNamespacePrincipal(namespaceId: string): string {
  const id = namespaceId.trim();
  if (!id) {
    throw new Error("namespace id must be non-empty");
  }
  return `${NAMESPACE_PRINCIPAL_PREFIX}${id}`;
}

export function toOrganizationPrincipal(organizationId: string): string {
  const id = organizationId.trim();
  if (!id) {
    throw new Error("organization id must be non-empty");
  }
  return `${ORGANIZATION_PRINCIPAL_PREFIX}${id}`;
}

export function isValidMemoryReadPrincipal(principal: string): boolean {
  return PRINCIPAL_PATTERN.test(principal.trim());
}

export function normalizeReadPrincipal(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("read ACL entry must be non-empty");
  }

  if (isValidMemoryReadPrincipal(trimmed)) {
    return trimmed;
  }

  // Convenience: bare Parse objectId → user principal (real Papr account)
  if (!trimmed.includes(":")) {
    return toUserPrincipal(trimmed);
  }

  throw new Error(
    `Invalid read ACL principal "${trimmed}". Use user:{objectId}, namespace:{id}, or organization:{id}.`,
  );
}

export function dedupeReadPrincipals(read: string[]): string[] {
  return [...new Set(read.map((entry) => normalizeReadPrincipal(entry)))];
}

export interface ExplicitMemoryReadAclInput {
  readAcl?: string[];
  shareWithUserIds?: string[];
  shareWithNamespaceId?: string;
  shareWithOrganizationId?: string;
}

export function hasExplicitMemoryReadAcl(
  input: ExplicitMemoryReadAclInput,
): boolean {
  return (
    (input.readAcl?.length ?? 0) > 0 ||
    (input.shareWithUserIds?.length ?? 0) > 0 ||
    Boolean(input.shareWithNamespaceId?.trim()) ||
    Boolean(input.shareWithOrganizationId?.trim())
  );
}

/** Build read principals from agent-friendly inputs. */
export function buildExplicitReadPrincipals(
  input: ExplicitMemoryReadAclInput,
): string[] {
  const read: string[] = [];

  for (const userId of input.shareWithUserIds ?? []) {
    read.push(toUserPrincipal(userId));
  }

  for (const principal of input.readAcl ?? []) {
    read.push(normalizeReadPrincipal(principal));
  }

  const namespaceId = input.shareWithNamespaceId?.trim();
  if (namespaceId) {
    read.push(toNamespacePrincipal(namespaceId));
  }

  const organizationId = input.shareWithOrganizationId?.trim();
  if (organizationId) {
    read.push(toOrganizationPrincipal(organizationId));
  }

  return dedupeReadPrincipals(read);
}

/** Writer keeps write access via their real Papr account principal. */
export function buildWriterWriteAcl(writerUserId: string): string[] {
  return [toUserPrincipal(writerUserId)];
}

/** Apply explicit read ACL, always keeping the writer on write ACL. */
export function applyExplicitReadAclToPolicy(
  basePolicy: MemoryAddPolicy | undefined,
  input: {
    /** Real Papr _User.objectId of the acting user. */
    writerExternalUserId: string;
    explicitRead: ExplicitMemoryReadAclInput;
  },
): MemoryAddPolicy {
  const read = buildExplicitReadPrincipals(input.explicitRead);
  if (read.length === 0) {
    throw new Error("explicit read ACL resolved to an empty list");
  }

  return {
    ...basePolicy,
    acl: {
      ...(basePolicy?.acl ?? {}),
      read,
      write: buildWriterWriteAcl(input.writerExternalUserId),
    },
  };
}
