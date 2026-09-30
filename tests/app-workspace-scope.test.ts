import { describe, expect, it } from "vitest";
import {
  isAppAssignedToWorkspace,
  isAppAwaitingAssignmentInWorkspace,
  isAppUnassignedInActiveWorkspace,
  isAppWorkspaceUnassigned,
  mergeAppWorkspaceFields,
  preserveLocalWorkspaceScopeInPulledMetadata,
  repairPulledMetadataWorkspaceScope,
  resolveWorkspaceScopeForPulledMetadata,
  shouldPruneStrayWorkspaceAppCopy,
  shouldShowAppInMyApps,
} from "../src/core/utils/appWorkspaceScope.js";

const scopeA = {
  organizationId: "org-a",
  namespaceId: "ns-a",
};

describe("appWorkspaceScope", () => {
  it("treats missing org or namespace as unassigned", () => {
    expect(isAppWorkspaceUnassigned({})).toBe(true);
    expect(isAppWorkspaceUnassigned({ organizationId: "org-a" })).toBe(true);
    expect(
      isAppWorkspaceUnassigned({
        organizationId: "org-a",
        namespaceId: "ns-a",
      }),
    ).toBe(false);
  });

  it("shows only assigned apps in My Apps when workspace is active", () => {
    expect(
      shouldShowAppInMyApps(
        "app-1",
        { organizationId: "org-a", namespaceId: "ns-a" },
        scopeA,
      ),
    ).toBe(true);
    expect(
      shouldShowAppInMyApps(
        "app-1",
        { organizationId: "org-a", namespaceId: "ns-b" },
        scopeA,
      ),
    ).toBe(false);
    expect(shouldShowAppInMyApps("app-1", {}, scopeA)).toBe(false);
  });

  it("always shows bundled default apps", () => {
    expect(
      shouldShowAppInMyApps(
        "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c",
        {},
        scopeA,
      ),
    ).toBe(true);
  });

  it("flags unassigned copies in the active workspace", () => {
    expect(
      isAppUnassignedInActiveWorkspace(
        "app-1",
        { organizationId: "org-a", namespaceId: "ns-b" },
        scopeA,
      ),
    ).toBe(true);
    expect(
      isAppUnassignedInActiveWorkspace(
        "app-1",
        { organizationId: "org-a", namespaceId: "ns-a" },
        scopeA,
      ),
    ).toBe(false);
  });

  it("merges index and disk workspace fields with disk winning", () => {
    expect(
      mergeAppWorkspaceFields(
        { organizationId: "org-index", namespaceId: "ns-index" },
        { organizationId: "org-disk", namespaceId: "ns-disk" },
      ),
    ).toEqual({
      organizationId: "org-disk",
      namespaceId: "ns-disk",
    });
  });

  it("matches assignment exactly", () => {
    expect(
      isAppAssignedToWorkspace(
        { organizationId: "org-a", namespaceId: "ns-a" },
        scopeA,
      ),
    ).toBe(true);
  });

  it("only prompts assignment for truly unassigned apps in the workspace", () => {
    expect(isAppAwaitingAssignmentInWorkspace("app-1", {}, scopeA)).toBe(true);
    expect(
      isAppAwaitingAssignmentInWorkspace(
        "app-1",
        { organizationId: "org-b", namespaceId: "ns-b" },
        scopeA,
      ),
    ).toBe(false);
    expect(
      isAppAwaitingAssignmentInWorkspace(
        "app-1",
        { organizationId: "org-a", namespaceId: "ns-a" },
        scopeA,
      ),
    ).toBe(false);
  });

  it("does not prune apps registered in apps.json for the active workspace", () => {
    const indexFields = { organizationId: "org-a", namespaceId: "ns-a" };
    const staleDiskFromCloudPull = {
      organizationId: "org-b",
      namespaceId: "ns-b",
    };
    expect(
      shouldPruneStrayWorkspaceAppCopy(indexFields, staleDiskFromCloudPull, scopeA),
    ).toBe(false);
  });

  it("still prunes foreign-owned copies not in the active workspace index", () => {
    const indexFields = { organizationId: "org-b", namespaceId: "ns-b" };
    const diskFields = { organizationId: "org-b", namespaceId: "ns-b" };
    expect(shouldPruneStrayWorkspaceAppCopy(indexFields, diskFields, scopeA)).toBe(
      true,
    );
  });

  it("preserves local workspace scope when pulling metadata for an owned app", () => {
    const pulled = JSON.stringify(
      {
        title: "Talent Assessment",
        organizationId: "org-b",
        namespaceId: "ns-b",
      },
      null,
      2,
    );
    const result = repairPulledMetadataWorkspaceScope(
      pulled,
      { organizationId: "org-a", namespaceId: "ns-a" },
      scopeA,
    );
    const parsed = JSON.parse(result.content) as {
      organizationId: string;
      namespaceId: string;
      title: string;
    };
    expect(parsed.organizationId).toBe("org-a");
    expect(parsed.namespaceId).toBe("ns-a");
    expect(parsed.title).toBe("Talent Assessment");
  });

  it("stamps active home scope when index is unassigned and cloud metadata is foreign", () => {
    const pulled = JSON.stringify(
      { title: "App", organizationId: "org-b", namespaceId: "ns-b" },
      null,
      2,
    );
    const result = repairPulledMetadataWorkspaceScope(pulled, {}, scopeA);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.organizationId).toBe("org-a");
    expect(parsed.namespaceId).toBe("ns-a");
    expect(parsed.title).toBe("App");
    expect(result.repaired).toBe(true);
    expect(result.appliedScope).toEqual(scopeA);
  });

  it("resolveWorkspaceScopeForPulledMetadata prefers index then home path", () => {
    expect(
      resolveWorkspaceScopeForPulledMetadata(
        { organizationId: "org-a", namespaceId: "ns-a" },
        scopeA,
      ),
    ).toEqual(scopeA);
    expect(resolveWorkspaceScopeForPulledMetadata({}, scopeA)).toEqual(scopeA);
    expect(
      resolveWorkspaceScopeForPulledMetadata(
        { organizationId: "org-b", namespaceId: "ns-b" },
        scopeA,
      ),
    ).toBeNull();
  });
});
