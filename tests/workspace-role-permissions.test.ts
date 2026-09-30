import { describe, expect, it } from "vitest";
import {
  canAssignWorkspaceRole,
  canModifyMemberRole,
  normalizeWorkspaceRole,
} from "../src/core/utils/workspaceRolePermissions.js";

const members = [
  {
    user: { objectId: "owner-1", role: "owner" },
  },
  {
    user: { objectId: "admin-1", role: "admin" },
  },
  {
    user: { objectId: "member-1", role: "member" },
  },
];

describe("workspaceRolePermissions", () => {
  it("normalizes founder to owner", () => {
    expect(normalizeWorkspaceRole("founder-workspace123")).toBe("owner");
  });

  it("allows owners to modify other members", () => {
    expect(
      canModifyMemberRole({
        currentUserId: "owner-1",
        currentUserRole: "owner",
        targetMember: members[2],
        members,
      }),
    ).toBe(true);
  });

  it("blocks admins from modifying other admins", () => {
    expect(
      canModifyMemberRole({
        currentUserId: "admin-1",
        currentUserRole: "admin",
        targetMember: members[0],
        members,
      }),
    ).toBe(false);
  });

  it("blocks the last owner from editing their own role", () => {
    expect(
      canModifyMemberRole({
        currentUserId: "owner-1",
        currentUserRole: "owner",
        targetMember: members[0],
        members: [members[0], members[2]],
      }),
    ).toBe(false);
  });

  it("blocks admins from promoting to admin", () => {
    const result = canAssignWorkspaceRole("admin", {
      currentUserId: "admin-1",
      currentUserRole: "admin",
      targetMember: members[2],
      members,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Admins can only assign the Member role",
    });
  });
});
