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
});
