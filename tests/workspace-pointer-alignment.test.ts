import { describe, expect, it } from "vitest";
import {
  isWorkspacePointerAlignedWithProfile,
  type ActiveWorkspacePointer,
} from "../src/core/utils/paprWorkspace.js";

const pointer = (
  organizationId: string,
  namespaceId: string,
): ActiveWorkspacePointer => ({
  organizationId,
  namespaceId,
  paprHome: `/Papr/orgs/${organizationId}/namespaces/${namespaceId}`,
  userDataPath: `/paprwork/orgs/${organizationId}/namespaces/${namespaceId}`,
  activatedAt: new Date().toISOString(),
});

describe("isWorkspacePointerAlignedWithProfile", () => {
  it("returns true when profile has no org/namespace selection", () => {
    expect(
      isWorkspacePointerAlignedWithProfile({}, pointer("org-a", "ns-a")),
    ).toBe(true);
  });

  it("returns false when pointer is missing but profile has selection", () => {
    expect(
      isWorkspacePointerAlignedWithProfile(
        { organizationId: "org-a", activeNamespaceId: "ns-a" },
        null,
      ),
    ).toBe(false);
  });

  it("returns true when org and namespace match", () => {
    expect(
      isWorkspacePointerAlignedWithProfile(
        { organizationId: "org-a", activeNamespaceId: "ns-a" },
        pointer("org-a", "ns-a"),
      ),
    ).toBe(true);
  });

  it("returns false when namespace differs", () => {
    expect(
      isWorkspacePointerAlignedWithProfile(
        { organizationId: "org-a", activeNamespaceId: "ns-b" },
        pointer("org-a", "ns-a"),
      ),
    ).toBe(false);
  });

  it("returns false when org differs", () => {
    expect(
      isWorkspacePointerAlignedWithProfile(
        { organizationId: "org-b", activeNamespaceId: "ns-a" },
        pointer("org-a", "ns-a"),
      ),
    ).toBe(false);
  });
});
