import { describe, it, expect } from "vitest";
import {
  dedupeCachedWorkspaces,
  type CachedWorkspace,
} from "../src/electron/ipc/paprWorkspaceCache.js";

function workspace(
  id: string,
  name: string,
  defaultNamespaceId?: string,
  organizationId = "Y8D4H7Yp3Z",
): CachedWorkspace {
  return { id, name, organizationId, defaultNamespaceId };
}

describe("dedupeCachedWorkspaces", () => {
  it("collapses workspaces pointing at the same org + namespace", () => {
    const result = dedupeCachedWorkspaces([
      workspace("7I5tUcLunV", "null (you)", "85ZIB7mD1V"),
      workspace("eZpxfyPoG2", "Papr", "85ZIB7mD1V"),
      workspace("gWjcH8KOFA", "Papr", "85ZIB7mD1V"),
      workspace("8iYWy5F10q", "Papr", "85ZIB7mD1V"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].defaultNamespaceId).toBe("85ZIB7mD1V");
  });

  it("prefers a real name over null/undefined/Workspace placeholders", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "null", "ns-1"),
      workspace("b", "Workspace", "ns-1"),
      workspace("c", "Papr", "ns-1"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Papr");
  });

  it("keeps workspaces from different namespaces", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "Papr", "ns-1"),
      workspace("b", "Acme", "ns-2"),
    ]);

    expect(result).toHaveLength(2);
  });

  it("keeps workspaces from different orgs sharing a namespace id", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "Papr", "ns-1", "org-1"),
      workspace("b", "Acme", "ns-1", "org-2"),
    ]);

    expect(result).toHaveLength(2);
  });

  it("does not merge entries that have no namespace yet", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "Papr", undefined),
      workspace("b", "Acme", undefined),
    ]);

    expect(result).toHaveLength(2);
  });

  it("is a no-op for an already clean list", () => {
    const input = [workspace("a", "Papr", "ns-1")];
    expect(dedupeCachedWorkspaces(input)).toEqual(input);
  });

  it("handles an empty list", () => {
    expect(dedupeCachedWorkspaces([])).toEqual([]);
  });

  // resolveNamespaceOrganizationId maps every workspace where the user owns a
  // non-matching org onto their single developer org, so distinct workspaces
  // arrive sharing an organizationId and defaultNamespaceId. Collapsing those
  // left the switcher with one row and no way out of it.
  it("keeps differently named workspaces that resolve to the same developer org", () => {
    const result = dedupeCachedWorkspaces([
      workspace("ws-sqa", "SQA Service", "ns-dev", "org-dev"),
      workspace("ws-papr", "papr-ai", "ns-dev", "org-dev"),
    ]);

    expect(result.map((entry) => entry.name)).toEqual(["SQA Service", "papr-ai"]);
  });

  it("still absorbs placeholder rows into a named row in the same scope", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "Workspace", "ns-1"),
      workspace("b", "papr-ai", "ns-1"),
      workspace("c", "null (you)", "ns-1"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("papr-ai");
  });

  it("collapses repeats of the same name but keeps the other workspace", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a1", "Papr", "ns-1"),
      workspace("a2", "Papr", "ns-1"),
      workspace("b1", "Acme", "ns-1"),
    ]);

    expect(result.map((entry) => entry.name)).toEqual(["Papr", "Acme"]);
  });

  it("treats names differing only by the (you) suffix as the same workspace", () => {
    const result = dedupeCachedWorkspaces([
      workspace("a", "Acme", "ns-1"),
      workspace("b", "Acme (you)", "ns-1"),
    ]);

    expect(result).toHaveLength(1);
  });

  // Duplicate provisioning leaves several same-named workspaces in one scope and
  // only one is the workspace the team uses. Keeping the first-seen row picked a
  // one-member shell, so the switcher showed "Papr" pointing at the wrong id and
  // the team list came back with only the viewer in it.
  describe("choosing between duplicates of the same name", () => {
    it("keeps the workspace its organization points at", () => {
      const result = dedupeCachedWorkspaces([
        { ...workspace("shell", "Papr", "ns-1"), memberCount: 1 },
        { ...workspace("real", "Papr", "ns-1"), memberCount: 601, isOrgPrimary: true },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("real");
    });

    it("falls back to member count when neither row is org primary", () => {
      const result = dedupeCachedWorkspaces([
        { ...workspace("shell", "Papr", "ns-1"), memberCount: 1 },
        { ...workspace("real", "Papr", "ns-1"), memberCount: 601 },
      ]);

      expect(result.map((entry) => entry.id)).toEqual(["real"]);
    });

    // The org pointer is the org naming its own authoritative workspace, so it
    // outranks a headcount that duplicate rows can inflate.
    it("prefers the org primary row over a larger non-primary one", () => {
      const result = dedupeCachedWorkspaces([
        { ...workspace("big", "Papr", "ns-1"), memberCount: 900 },
        { ...workspace("primary", "Papr", "ns-1"), memberCount: 601, isOrgPrimary: true },
      ]);

      expect(result[0].id).toBe("primary");
    });

    it("ranks a known member count above an unreadable one", () => {
      const result = dedupeCachedWorkspaces([
        workspace("unknown", "Papr", "ns-1"),
        { ...workspace("known", "Papr", "ns-1"), memberCount: 1 },
      ]);

      expect(result[0].id).toBe("known");
    });

    it("keeps first-seen order when no row has a stronger claim", () => {
      const result = dedupeCachedWorkspaces([
        workspace("first", "Papr", "ns-1"),
        workspace("second", "Papr", "ns-1"),
      ]);

      expect(result[0].id).toBe("first");
    });

    it("applies the same ranking to placeholder-only scopes", () => {
      const result = dedupeCachedWorkspaces([
        { ...workspace("shell", "null (you)", "ns-1"), memberCount: 1 },
        { ...workspace("real", "null (you)", "ns-1"), memberCount: 601, isOrgPrimary: true },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("real");
    });

    // The live papr-ai rows: five typo-slug duplicates with one member each
    // alongside the 601-member workspace the org actually points at.
    it("picks the real papr-ai workspace out of its typo duplicates", () => {
      const duplicate = (id: string): CachedWorkspace => ({
        ...workspace(id, "Papr", "85ZIB7mD1V"),
        memberCount: 1,
      });

      const result = dedupeCachedWorkspaces([
        { ...workspace("7I5tUcLunV", "null (you)", "85ZIB7mD1V"), memberCount: 1 },
        duplicate("eZpxfyPoG2"),
        duplicate("gWjcH8KOFA"),
        duplicate("8iYWy5F10q"),
        duplicate("tDu6TjHL3x"),
        {
          ...workspace("qDgAdi2eMf", "Papr", "85ZIB7mD1V"),
          memberCount: 601,
          isOrgPrimary: true,
        },
        duplicate("9RSVXV8mEJ"),
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("qDgAdi2eMf");
    });
  });
});
