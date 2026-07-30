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
});
