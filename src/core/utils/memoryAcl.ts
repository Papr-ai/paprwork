/**
 * Papr Memory ACL helpers.
 *
 * Use Parse _User.objectId as external_user_id on memory.add bodies.
 * ACL principals use the external_user:{objectId} prefix — NOT bare user ids
 * and NOT Papr's internal user_id field.
 */

import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";

export const EXTERNAL_USER_PRINCIPAL_PREFIX = "external_user:" as const;
export const NAMESPACE_PRINCIPAL_PREFIX = "namespace:" as const;
export const ORGANIZATION_PRINCIPAL_PREFIX = "organization:" as const;

const PRINCIPAL_PATTERN =
  /^(external_user|namespace|organization):[A-Za-z0-9_-]+$/;

/** Strip `external_user:` prefix if the agent pasted a full principal. */
export function normalizeExternalUserId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(EXTERNAL_USER_PRINCIPAL_PREFIX)) {
    return trimmed.slice(EXTERNAL_USER_PRINCIPAL_PREFIX.length).trim();
  }
  return trimmed;
}

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

  // Convenience: bare Parse objectId → external_user principal
  if (!trimmed.includes(":")) {
    return toExternalUserPrincipal(trimmed);
  }

  throw new Error(
    `Invalid read ACL principal "${trimmed}". Use external_user:{objectId}, namespace:{id}, or organization:{id}.`,
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
    read.push(toExternalUserPrincipal(userId));
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

export function buildWriterWriteAcl(writerExternalUserId: string): string[] {
  return [toExternalUserPrincipal(writerExternalUserId)];
}

/** Apply explicit read ACL, always keeping the writer on write ACL. */
export function applyExplicitReadAclToPolicy(
  basePolicy: MemoryAddPolicy | undefined,
  input: {
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
