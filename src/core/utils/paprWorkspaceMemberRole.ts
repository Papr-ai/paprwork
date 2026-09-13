/**
 * Workspace member role changes via papr-dev-platform APIs.
 * Mirrors dashboard PeopleSection role transitions.
 */

import {
  normalizeWorkspaceRole,
  type WorkspaceRoleName,
} from "./workspaceRolePermissions.js";

const PAPR_PLATFORM_URL = (
  process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
).replace(/\/$/, "");

export interface UpdateWorkspaceMemberRoleInput {
  sessionToken: string;
  workspaceId: string;
  userId: string;
  currentRole: string;
  newRole: WorkspaceRoleName;
}

async function callWorkspaceRoleRoute(
  sessionToken: string,
  route: "updateUserRole" | "removeUserRole",
  workspaceId: string,
  userId: string,
  role: "owner" | "admin",
): Promise<void> {
  const response = await fetch(`${PAPR_PLATFORM_URL}/api/workspace/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ workspaceId, userId, role }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to ${route} (${response.status})`);
  }
}

export async function updateWorkspaceMemberRole(
  input: UpdateWorkspaceMemberRoleInput,
): Promise<void> {
  const currentRole = normalizeWorkspaceRole(input.currentRole);
  const newRole = input.newRole;

  if (currentRole === newRole) {
    return;
  }

  const isCurrentlyOwner = currentRole === "owner";
  const isCurrentlyAdmin = currentRole === "admin";

  switch (newRole) {
    case "owner":
      if (!isCurrentlyOwner) {
        if (isCurrentlyAdmin) {
          await callWorkspaceRoleRoute(
            input.sessionToken,
            "removeUserRole",
            input.workspaceId,
            input.userId,
            "admin",
          );
        }
        await callWorkspaceRoleRoute(
          input.sessionToken,
          "updateUserRole",
          input.workspaceId,
          input.userId,
          "owner",
        );
      }
      return;

    case "admin":
      if (isCurrentlyOwner) {
        await callWorkspaceRoleRoute(
          input.sessionToken,
          "removeUserRole",
          input.workspaceId,
          input.userId,
          "owner",
        );
      }
      if (!isCurrentlyAdmin) {
        await callWorkspaceRoleRoute(
          input.sessionToken,
          "updateUserRole",
          input.workspaceId,
          input.userId,
          "admin",
        );
      }
      return;

    case "member":
      if (isCurrentlyOwner) {
        await callWorkspaceRoleRoute(
          input.sessionToken,
          "removeUserRole",
          input.workspaceId,
          input.userId,
          "owner",
        );
      }
      if (isCurrentlyAdmin) {
        await callWorkspaceRoleRoute(
          input.sessionToken,
          "removeUserRole",
          input.workspaceId,
          input.userId,
          "admin",
        );
      }
      return;
  }
}
