export type IntegrationKeyVaultAudience = "user" | "namespace" | "org";

export const VAULT_AUDIENCE_LABELS: Record<
  IntegrationKeyVaultAudience,
  { label: string; hint: string }
> = {
  user: {
    label: "Only me",
    hint: "Private to your account on this device and in cloud vault",
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
