/**
 * Default org/namespace naming for first-time Papr provisioning.
 */

export const DEFAULT_NAMESPACE_NAME = "GTM Team";

/** Common consumer email domains — use display/workspace name instead of domain. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "fastmail.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "gmx.com",
  "hey.com",
]);

const GENERIC_WORKSPACE_NAMES = new Set([
  "papr",
  "default",
  "workspace",
  "my workspace",
  "personal",
]);

export interface DeriveDefaultOrgNameInput {
  email: string;
  displayName?: string;
  workspaceName?: string;
}

export interface ProvisioningNameDefaults {
  orgName: string;
  namespaceName: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function companyNameFromEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return undefined;
  }

  const labels = domain.split(".").filter(Boolean);
  const base = labels[0] === "www" && labels.length > 1 ? labels[1] : labels[0];
  if (!base) return undefined;

  const cleaned = base.replace(/[^a-z0-9-]/gi, " ").trim();
  if (!cleaned) return undefined;

  return cleaned
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

function displayNameToOrgName(displayName: string | undefined): string | undefined {
  if (!displayName?.trim()) return undefined;
  const normalized = normalizeWhitespace(displayName);
  if (!normalized) return undefined;

  const first = normalized.split(" ")[0];
  return first.length >= 2 ? first : normalized;
}

function workspaceNameToOrgName(workspaceName: string | undefined): string | undefined {
  if (!workspaceName?.trim()) return undefined;
  const normalized = normalizeWhitespace(workspaceName);
  if (!normalized) return undefined;
  if (GENERIC_WORKSPACE_NAMES.has(normalized.toLowerCase())) {
    return undefined;
  }
  return normalized;
}

function emailLocalPartToOrgName(email: string): string {
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const cleaned = local.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return "My Organization";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

/** Priority: workspace name → display name → company domain → email local part. */
export function deriveDefaultOrgName(input: DeriveDefaultOrgNameInput): string {
  return (
    workspaceNameToOrgName(input.workspaceName) ??
    displayNameToOrgName(input.displayName) ??
    companyNameFromEmailDomain(input.email) ??
    emailLocalPartToOrgName(input.email)
  );
}

export function deriveProvisioningDefaults(
  input: DeriveDefaultOrgNameInput,
): ProvisioningNameDefaults {
  return {
    orgName: deriveDefaultOrgName(input),
    namespaceName: DEFAULT_NAMESPACE_NAME,
  };
}

export function sanitizeProvisioningName(
  value: string,
  fallback: string,
  maxLength = 64,
): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

export type ProvisioningPlanKind =
  | "none"
  | "namespace_only"
  | "org_and_namespace";

export interface ProvisioningPlanInput {
  workspaceId?: string;
  workspaceHasOrganization: boolean;
  workspaceOrgHasDefaultNamespace: boolean;
  developerOrgId?: string;
  developerOrgHasDefaultNamespace: boolean;
}

export interface ProvisioningPlan {
  kind: ProvisioningPlanKind;
  needsOrg: boolean;
  needsNamespace: boolean;
}

/** Pure decision tree mirroring provisionOrGetApiKey — easy to unit test. */
export function resolveProvisioningPlan(input: ProvisioningPlanInput): ProvisioningPlan {
  if (input.workspaceId && input.workspaceHasOrganization) {
    if (input.workspaceOrgHasDefaultNamespace) {
      return { kind: "none", needsOrg: false, needsNamespace: false };
    }
    return { kind: "namespace_only", needsOrg: false, needsNamespace: true };
  }

  if (input.developerOrgId) {
    if (input.developerOrgHasDefaultNamespace) {
      return { kind: "none", needsOrg: false, needsNamespace: false };
    }
    return { kind: "namespace_only", needsOrg: false, needsNamespace: true };
  }

  return { kind: "org_and_namespace", needsOrg: true, needsNamespace: true };
}

export function isProvisioningSetupRequired(plan: ProvisioningPlan): boolean {
  return plan.kind !== "none";
}
