export type IntegrationKeyVaultAudience =
  | "user"
  | "members"
  | "namespace"
  | "org";

export const VAULT_AUDIENCE_LABELS: Record<
  IntegrationKeyVaultAudience,
  { label: string; hint: string }
> = {
  user: {
    label: "Only me",
    hint: "Private to your account on this device and in cloud vault",
  },
  members: {
    label: "Selected members",
    hint: "Shared with specific workspace members you choose",
  },
  namespace: {
    label: "Team",
    hint: "Shared with everyone on your team (namespace vault)",
  },
  org: {
    label: "Organization",
    hint: "Shared with all members of this organization",
  },
};

export function formatVaultAudienceLabel(
  audience?: IntegrationKeyVaultAudience | null,
): string {
  if (
    audience === "members" ||
    audience === "namespace" ||
    audience === "org"
  ) {
    return VAULT_AUDIENCE_LABELS[audience].label;
  }
  return VAULT_AUDIENCE_LABELS.user.label;
}

export function isSharedVaultAudience(
  audience?: IntegrationKeyVaultAudience | null,
): boolean {
  return (
    audience === "members" ||
    audience === "namespace" ||
    audience === "org"
  );
}
