export const WORKSPACE_ROLE_PRIORITY = ["owner", "admin", "member"] as const;

export type WorkspaceRoleName = (typeof WORKSPACE_ROLE_PRIORITY)[number];

export function normalizeWorkspaceRole(
  role: string | null | undefined,
): WorkspaceRoleName {
  const base = role?.trim().toLowerCase().split("-")[0];
  if (base === "founder") {
    return "owner";
  }
  if (base === "owner" || base === "admin" || base === "member") {
    return base;
  }
  return "member";
}

export function formatWorkspaceRoleLabel(role: string): string {
  const normalized = normalizeWorkspaceRole(role);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

interface RoleMember {
  user: {
    objectId: string;
    role: string;
  };
}

export function countWorkspaceOwners(members: readonly RoleMember[]): number {
  return members.filter(
    (member) => normalizeWorkspaceRole(member.user.role) === "owner",
  ).length;
}

export function canModifyMemberRole(input: {
  currentUserId: string;
  currentUserRole: string;
  targetMember: RoleMember;
  members: readonly RoleMember[];
}): boolean {
  const currentRole = normalizeWorkspaceRole(input.currentUserRole);
  const targetRole = normalizeWorkspaceRole(input.targetMember.user.role);

  if (currentRole !== "owner" && currentRole !== "admin") {
    return false;
  }

  if (currentRole === "owner") {
    const isLastOwner =
      countWorkspaceOwners(input.members) <= 1 &&
      input.targetMember.user.objectId === input.currentUserId;
    if (isLastOwner) {
      return false;
    }
    return true;
  }

  return targetRole !== "owner" && targetRole !== "admin";
}

export function canAssignWorkspaceRole(
  newRole: WorkspaceRoleName,
  input: {
    currentUserId: string;
    currentUserRole: string;
    targetMember: RoleMember;
    members: readonly RoleMember[];
  },
): { allowed: true } | { allowed: false; reason: string } {
  if (!canModifyMemberRole(input)) {
    return { allowed: false, reason: "You do not have permission to change this role" };
  }

  const currentActorRole = normalizeWorkspaceRole(input.currentUserRole);
  if (currentActorRole === "admin" && (newRole === "owner" || newRole === "admin")) {
    return {
      allowed: false,
      reason: "Admins can only assign the Member role",
    };
  }

  const targetRole = normalizeWorkspaceRole(input.targetMember.user.role);
  const ownerCount = countWorkspaceOwners(input.members);
  const isTargetLastOwner =
    targetRole === "owner" &&
    ownerCount <= 1 &&
    input.targetMember.user.objectId !== input.currentUserId;

  if (isTargetLastOwner && newRole !== "owner") {
    return {
      allowed: false,
      reason: "Cannot remove the last owner. Assign another owner first.",
    };
  }

  return { allowed: true };
}
