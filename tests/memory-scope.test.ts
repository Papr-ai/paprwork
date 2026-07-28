import { describe, expect, it } from "vitest";
import {
  buildMemoryScopeFields,
  buildMemorySearchScopeFields,
  mergeMemoryAddPolicy,
  resolveMemoryAudience,
} from "../src/core/utils/memoryScope.js";

const ctx = {
  userId: "user-1",
  namespaceId: "ns-abc",
  organizationId: "org-xyz",
};

describe("memoryScope", () => {
  it("resolveMemoryAudience follows override → chat → default → user", () => {
    expect(
      resolveMemoryAudience({
        explicit: "org",
        chatScope: "namespace",
        defaultScope: "user",
      }),
    ).toBe("org");
    expect(
      resolveMemoryAudience({
        chatScope: "namespace",
        defaultScope: "user",
      }),
    ).toBe("namespace");
    expect(resolveMemoryAudience({ defaultScope: "org" })).toBe("org");
    expect(resolveMemoryAudience({})).toBe("user");
  });

  it("buildMemoryScopeFields scopes namespace memories with ACL", () => {
    expect(buildMemoryScopeFields("namespace", ctx)).toEqual({
      external_user_id: "user-1",
      namespace_id: "ns-abc",
      policy: {
        acl: {
          read: ["namespace:ns-abc"],
          write: ["external_user:user-1"],
        },
      },
    });
  });

  it("buildMemoryScopeFields scopes org memories with ACL", () => {
    expect(buildMemoryScopeFields("org", ctx)).toEqual({
      external_user_id: "user-1",
      namespace_id: "ns-abc",
      policy: {
        acl: {
          read: ["organization:org-xyz"],
          write: ["external_user:user-1"],
        },
      },
    });
  });

  it("buildMemoryScopeFields user scope is external_user_id only", () => {
    expect(buildMemoryScopeFields("user", ctx)).toEqual({
      external_user_id: "user-1",
    });
  });

  it("buildMemoryScopeFields falls back to user when namespace id missing", () => {
    expect(
      buildMemoryScopeFields("namespace", { userId: "user-1" }),
    ).toEqual({
      external_user_id: "user-1",
    });
  });

  it("buildMemorySearchScopeFields expands read ACL for namespace/org", () => {
    expect(buildMemorySearchScopeFields("namespace", ctx)).toEqual({
      external_user_id: "user-1",
      search_acl: { read: ["namespace:ns-abc"] },
    });
    expect(buildMemorySearchScopeFields("org", ctx)).toEqual({
      external_user_id: "user-1",
      search_acl: { read: ["organization:org-xyz"] },
    });
    expect(buildMemorySearchScopeFields("user", ctx)).toEqual({
      external_user_id: "user-1",
    });
  });

  it("mergeMemoryAddPolicy combines transform_embedding with scope ACL", () => {
    const merged = mergeMemoryAddPolicy(
      {
        transform_embedding: { mode: "auto", domain_id: "general" },
      },
      {
        acl: {
          read: ["namespace:ns-abc"],
          write: ["external_user:user-1"],
        },
      },
    );
    expect(merged).toEqual({
      transform_embedding: { mode: "auto", domain_id: "general" },
      acl: {
        read: ["namespace:ns-abc"],
        write: ["external_user:user-1"],
      },
    });
  });
});
