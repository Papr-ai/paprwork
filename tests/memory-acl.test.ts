import { describe, expect, it } from "vitest";
import {
  applyExplicitReadAclToPolicy,
  buildExplicitReadPrincipals,
  hasExplicitMemoryReadAcl,
  normalizeExternalUserId,
  normalizeReadPrincipal,
  toExternalUserPrincipal,
  toUserPrincipal,
} from "../src/core/utils/memoryAcl.js";

describe("memoryAcl", () => {
  it("normalizes user ids and principals", () => {
    expect(normalizeExternalUserId("abc123")).toBe("abc123");
    expect(normalizeExternalUserId("user:abc123")).toBe("abc123");
    expect(normalizeExternalUserId("external_user:abc123")).toBe("abc123");
    // Paprwork users are real Papr accounts → user: principals
    expect(toUserPrincipal("abc123")).toBe("user:abc123");
    expect(normalizeReadPrincipal("abc123")).toBe("user:abc123");
    expect(normalizeReadPrincipal("namespace:ns-1")).toBe("namespace:ns-1");
    // Retained for third-party SDK end users (no Papr account)
    expect(toExternalUserPrincipal("abc123")).toBe("external_user:abc123");
    expect(normalizeReadPrincipal("external_user:abc123")).toBe(
      "external_user:abc123",
    );
  });

  it("builds explicit read principals from user ids and ACL entries", () => {
    expect(
      buildExplicitReadPrincipals({
        shareWithUserIds: ["user-a", "user:user-b"],
        readAcl: ["namespace:ns-abc"],
        shareWithOrganizationId: "org-xyz",
      }),
    ).toEqual([
      "user:user-a",
      "user:user-b",
      "namespace:ns-abc",
      "organization:org-xyz",
    ]);
  });

  it("detects explicit ACL input", () => {
    expect(hasExplicitMemoryReadAcl({})).toBe(false);
    expect(
      hasExplicitMemoryReadAcl({ shareWithUserIds: ["user-1"] }),
    ).toBe(true);
  });

  it("applyExplicitReadAclToPolicy keeps writer on write ACL", () => {
    const policy = applyExplicitReadAclToPolicy(
      { transform_embedding: { mode: "auto", domain_id: "general" } },
      {
        writerExternalUserId: "recorder-1",
        explicitRead: {
          shareWithUserIds: ["attendee-1"],
          shareWithNamespaceId: "ns-abc",
        },
      },
    );

    expect(policy).toEqual({
      transform_embedding: { mode: "auto", domain_id: "general" },
      acl: {
        read: ["user:attendee-1", "namespace:ns-abc"],
        write: ["user:recorder-1"],
      },
    });
  });
});
