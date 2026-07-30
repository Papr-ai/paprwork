import { describe, expect, it } from "vitest";
import {
  isAppAssignedToWorkspace,
  isAppAwaitingAssignmentInWorkspace,
  isAppUnassignedInActiveWorkspace,
  isAppWorkspaceUnassigned,
  mergeAppWorkspaceFields,
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

  it("merges index and disk workspace fields with index winning", () => {
    expect(
      mergeAppWorkspaceFields(
        { organizationId: "org-index", namespaceId: "ns-index" },
        { organizationId: "org-disk", namespaceId: "ns-disk" },
      ),
    ).toEqual({
      organizationId: "org-index",
      namespaceId: "ns-index",
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
});
