/**
 * GET /api/members — workspace roster for mini-app role pickers (desktop + cloud).
 */

import {
  fetchWorkspaceMembers,
  resolveWorkspaceIdForContext,
  WorkspaceContextResolutionError,
  type WorkspaceMember,
} from "../../../core/utils/paprWorkspaceTeam.js";
import { readActiveWorkspacePointer } from "../../../core/utils/paprWorkspace.js";
import type {
  AppAccessContext,
  MiniAppMembersResponse,
  MiniAppWorkspaceMember,
} from "./types.js";

export class MiniAppMembersError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiniAppMembersError";
  }
}

export function canListMiniAppMembers(
  loggedIn: boolean,
  access: AppAccessContext | null,
): boolean {
  return loggedIn && Boolean(access?.canRead);
}

function mapMember(member: WorkspaceMember): MiniAppWorkspaceMember {
  return {
    userId: member.user.objectId,
    email: member.user.email,
    displayName: member.user.displayName,
    role: member.user.role,
    ...(member.user.profileImageUrl
      ? { profileImageUrl: member.user.profileImageUrl }
      : {}),
  };
}

/** Fetch workspace members for a signed-in mini-app caller. */
export async function listMiniAppMembers(input: {
  sessionToken: string;
  namespaceId?: string;
  workspaceId?: string;
  workspaceName?: string;
}): Promise<MiniAppMembersResponse> {
  const sessionToken = input.sessionToken.trim();
  if (!sessionToken) {
    throw new MiniAppMembersError(
      "Sign in with Papr to list workspace members.",
      401,
    );
  }

  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceIdForContext(sessionToken, {
      workspaceId: input.workspaceId,
      namespaceId: input.namespaceId,
    });
  } catch (err) {
    if (err instanceof WorkspaceContextResolutionError) {
      throw new MiniAppMembersError(err.message, 503);
    }
    throw err;
  }

  const members = await fetchWorkspaceMembers(sessionToken, workspaceId);
  const namespaceId =
    input.namespaceId?.trim() ||
    process.env.PAPR_NAMESPACE_ID?.trim() ||
    readActiveWorkspacePointer()?.namespaceId;

  return {
    workspaceId,
    ...(input.workspaceName?.trim()
      ? { workspaceName: input.workspaceName.trim() }
      : {}),
    ...(namespaceId ? { namespaceId } : {}),
    members: members.map(mapMember),
  };
}

export function assertMiniAppMembersAccess(
  loggedIn: boolean,
  access: AppAccessContext | null,
): void {
  if (!loggedIn) {
    throw new MiniAppMembersError(
      "Sign in with Papr to list workspace members.",
      401,
    );
  }
  if (!access?.canRead) {
    throw new MiniAppMembersError("You do not have access to this app.", 403);
  }
}
