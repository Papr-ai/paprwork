/**
 * GET /api/members — workspace roster for mini-app role pickers (desktop + cloud).
 */

import {
  fetchWorkspaceMembers,
  resolveWorkspaceIdForNamespace,
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

async function resolveWorkspaceId(
  sessionToken: string,
  options: {
    workspaceId?: string;
    namespaceId?: string;
  },
): Promise<string> {
  const explicitWorkspaceId = options.workspaceId?.trim();
  if (explicitWorkspaceId) {
    return explicitWorkspaceId;
  }

  const namespaceId = options.namespaceId?.trim();
  if (namespaceId) {
    const fromNamespace = await resolveWorkspaceIdForNamespace(
      sessionToken,
      namespaceId,
    );
    if (fromNamespace) {
      return fromNamespace;
    }
    throw new MiniAppMembersError(
      "Could not resolve workspace for this namespace. Sign in again or contact support.",
      503,
    );
  }

  throw new MiniAppMembersError(
    "No workspace context is available for this app.",
    503,
  );
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

  const workspaceId = await resolveWorkspaceId(sessionToken, {
    workspaceId: input.workspaceId,
    namespaceId: input.namespaceId,
  });

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
