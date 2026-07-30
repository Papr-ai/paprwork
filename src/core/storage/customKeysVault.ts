/** User-selected visibility for integration keys. */
export type IntegrationKeyVaultAudience = "user" | "namespace" | "org";

export function normalizeIntegrationKeyVaultAudience(
  value?: IntegrationKeyVaultAudience | null,
): IntegrationKeyVaultAudience {
  if (value === "namespace" || value === "org") {
    return value;
  }
  return "user";
}

/** Cross-org integration keys (shared across all Papr workspaces). */
export const SHARED_ORG_ID = "_shared";

/** Offline / pre-Papr-login vault. */
export const LOCAL_ORG_ID = "_local";

/** User-selected visibility for integration keys. */
export type IntegrationKeyOrgScope = "organization" | "all";

export function isSharedOrgId(organizationId: string): boolean {
  return organizationId.trim() === SHARED_ORG_ID;
}

export function isLocalOrgId(organizationId: string): boolean {
  return organizationId.trim() === LOCAL_ORG_ID;
}

export function resolveIntegrationKeyOrganizationId(input: {
  orgScope?: IntegrationKeyOrgScope;
  organizationId?: string;
  activeOrganizationId?: string | null;
}): string {
  if (input.orgScope === "all" || input.orgScope === undefined) {
    return SHARED_ORG_ID;
  }

  const explicit = input.organizationId?.trim();
  if (explicit && !isSharedOrgId(explicit)) {
    return explicit;
  }

  const active = input.activeOrganizationId?.trim();
  if (active && !isSharedOrgId(active) && !isLocalOrgId(active)) {
    return active;
  }

  return LOCAL_ORG_ID;
}
