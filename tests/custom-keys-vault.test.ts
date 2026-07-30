import { describe, expect, it } from "vitest";
import {
  LOCAL_ORG_ID,
  SHARED_ORG_ID,
  normalizeIntegrationKeyVaultAudience,
  resolveIntegrationKeyOrganizationId,
} from "../src/core/storage/customKeysVault.js";

describe("customKeysVault", () => {
  it("routes cross-org keys to the shared vault", () => {
    expect(
      resolveIntegrationKeyOrganizationId({
        orgScope: "all",
        activeOrganizationId: "org-a",
      }),
    ).toBe(SHARED_ORG_ID);
  });

  it("defaults unset org scope to the shared (all orgs) vault", () => {
    expect(
      resolveIntegrationKeyOrganizationId({
        activeOrganizationId: "org-a",
      }),
    ).toBe(SHARED_ORG_ID);
  });

  it("defaults organization-scoped keys to the active org when explicit", () => {
    expect(
      resolveIntegrationKeyOrganizationId({
        orgScope: "organization",
        activeOrganizationId: "org-a",
      }),
    ).toBe("org-a");
  });

  it("honors an explicit target organization", () => {
    expect(
      resolveIntegrationKeyOrganizationId({
        orgScope: "organization",
        organizationId: "org-b",
        activeOrganizationId: "org-a",
      }),
    ).toBe("org-b");
  });

  it("falls back to local vault when no org is active", () => {
    expect(
      resolveIntegrationKeyOrganizationId({
        orgScope: "organization",
        activeOrganizationId: null,
      }),
    ).toBe(LOCAL_ORG_ID);
  });

  it("defaults unknown vault audience to user", () => {
    expect(normalizeIntegrationKeyVaultAudience(undefined)).toBe("user");
    expect(normalizeIntegrationKeyVaultAudience(null)).toBe("user");
    expect(normalizeIntegrationKeyVaultAudience("namespace")).toBe("namespace");
    expect(normalizeIntegrationKeyVaultAudience("org")).toBe("org");
  });
});
