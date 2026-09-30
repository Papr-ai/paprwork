import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMESPACE_NAME,
  deriveDefaultOrgName,
  deriveProvisioningDefaults,
  isProvisioningDeferred,
  isProvisioningSetupRequired,
  resolveProvisioningPlan,
  sanitizeProvisioningName,
} from "../src/core/papr/provisioningDefaults.js";

describe("deriveDefaultOrgName", () => {
  it("prefers an existing workspace name over email-derived values", () => {
    expect(
      deriveDefaultOrgName({
        email: "jane.smith@acme.com",
        displayName: "Jane Smith",
        workspaceName: "Acme GTM",
      }),
    ).toBe("Acme GTM");
  });

  it("uses display name when workspace name is generic", () => {
    expect(
      deriveDefaultOrgName({
        email: "jane.smith@gmail.com",
        displayName: "Jane Smith",
        workspaceName: "Papr",
      }),
    ).toBe("Jane");
  });

  it("uses company domain when no workspace or display name is available", () => {
    expect(
      deriveDefaultOrgName({
        email: "jane.smith@acme.com",
      }),
    ).toBe("Acme");
  });

  it("uses display name before company domain for work emails", () => {
    expect(
      deriveDefaultOrgName({
        email: "jane.smith@acme.com",
        displayName: "Jane Smith",
      }),
    ).toBe("Jane");
  });

  it("falls back to email local part for personal emails without workspace or name", () => {
    expect(
      deriveDefaultOrgName({
        email: "jane.smith@gmail.com",
      }),
    ).toBe("Jane Smith");
  });
});

describe("deriveProvisioningDefaults", () => {
  it("defaults namespace to GTM Team", () => {
    expect(
      deriveProvisioningDefaults({
        email: "amir@papr.ai",
        workspaceName: "Papr Sales",
      }),
    ).toEqual({
      orgName: "Papr Sales",
      namespaceName: DEFAULT_NAMESPACE_NAME,
    });
  });
});

describe("resolveProvisioningPlan", () => {
  it("skips setup when workspace org already has a default namespace", () => {
    const plan = resolveProvisioningPlan({
      workspaceId: "ws-1",
      workspaceOrganization: "present",
      workspaceOrgHasDefaultNamespace: true,
      developerOrgId: "dev-org",
      developerOrgHasDefaultNamespace: false,
    });

    expect(plan.kind).toBe("none");
    expect(isProvisioningSetupRequired(plan)).toBe(false);
  });

  it("requires namespace setup when workspace org exists without a namespace", () => {
    const plan = resolveProvisioningPlan({
      workspaceId: "ws-1",
      workspaceOrganization: "present",
      workspaceOrgHasDefaultNamespace: false,
      developerOrgId: "dev-org",
      developerOrgHasDefaultNamespace: true,
    });

    expect(plan).toEqual({
      kind: "namespace_only",
      needsOrg: false,
      needsNamespace: true,
    });
  });

  it("requires org and namespace for brand-new users", () => {
    const plan = resolveProvisioningPlan({
      workspaceId: "ws-1",
      workspaceOrganization: "absent",
      workspaceOrgHasDefaultNamespace: false,
      developerOrgHasDefaultNamespace: false,
    });

    expect(plan).toEqual({
      kind: "org_and_namespace",
      needsOrg: true,
      needsNamespace: true,
    });
  });

  it("defers when the workspace organization could not be read", () => {
    const plan = resolveProvisioningPlan({
      workspaceId: "ws-1",
      workspaceOrganization: "unknown",
      workspaceOrgHasDefaultNamespace: false,
      developerOrgHasDefaultNamespace: false,
    });

    expect(plan).toEqual({
      kind: "deferred",
      needsOrg: false,
      needsNamespace: false,
    });
    expect(isProvisioningSetupRequired(plan)).toBe(false);
    expect(isProvisioningDeferred(plan)).toBe(true);
  });

  it("defers rather than creating a second org when the developer org lookup fails", () => {
    const plan = resolveProvisioningPlan({
      workspaceOrganization: "absent",
      workspaceOrgHasDefaultNamespace: false,
      developerOrgHasDefaultNamespace: false,
      developerOrgLookupFailed: true,
    });

    expect(plan.kind).toBe("deferred");
    expect(isProvisioningDeferred(plan)).toBe(true);
  });
});

describe("sanitizeProvisioningName", () => {
  it("trims and falls back when empty", () => {
    expect(sanitizeProvisioningName("  Acme  ", "Fallback")).toBe("Acme");
    expect(sanitizeProvisioningName("   ", "Fallback")).toBe("Fallback");
  });
});
