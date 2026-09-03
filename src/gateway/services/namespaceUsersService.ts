/**
 * List Papr workspace members for agent-driven memory ACL decisions.
 */

import {
  fetchWorkspaceMembers,
  resolveWorkspaceIdForContext,
  type WorkspaceMember,
} from "../../core/utils/paprWorkspaceTeam.js";
import {
  toUserPrincipal,
  toNamespacePrincipal,
  toOrganizationPrincipal,
} from "../../core/utils/memoryAcl.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { getApiKey } from "../utils/keyResolver.js";
import {
  getGatewayPaprProfile,
  getPaprWorkspaceId,
} from "../utils/paprGatewayProfile.js";
import { getPaprUserId } from "../utils/paprUserId.js";

export interface NamespaceUserForAgent {
  externalUserId: string;
  email: string;
  displayName: string;
  role: string;
  memoryReadPrincipal: string;
}

export interface ListNamespaceUsersResult {
  workspaceId: string;
  workspaceName?: string;
  namespaceId?: string;
  organizationId?: string;
  recorderExternalUserId?: string;
  aclHints: {
    externalUser: string;
    namespace?: string;
    organization?: string;
  };
  members: NamespaceUserForAgent[];
}

function mapMemberForAgent(member: WorkspaceMember): NamespaceUserForAgent {
  const externalUserId = member.user.objectId;
  return {
    externalUserId,
    email: member.user.email,
    displayName: member.user.displayName,
    role: member.user.role,
    // Namespace members are real Papr accounts, so share via user: principals
    // (maps to user_read_access, which the search ACL filter evaluates).
    memoryReadPrincipal: toUserPrincipal(externalUserId),
  };
}

export async function listNamespaceUsersForAgent(): Promise<ListNamespaceUsersResult> {
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  if (!sessionToken) {
    throw new Error(
      "PAPR_SESSION_TOKEN is not configured. Sign in with Papr to list workspace members.",
    );
  }

  const pointer = readActiveWorkspacePointer();
  const profile = getGatewayPaprProfile();
  const recorderExternalUserId = getPaprUserId();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
  const organizationId =
    process.env.PAPR_ORG_ID?.trim() || pointer?.organizationId;

  const workspaceId = await resolveWorkspaceIdForContext(sessionToken, {
    workspaceId: getPaprWorkspaceId(),
    namespaceId,
  });

  const members = await fetchWorkspaceMembers(sessionToken, workspaceId);

  return {
    workspaceId,
    workspaceName: profile.paprWorkspaceName,
    namespaceId,
    organizationId,
    recorderExternalUserId,
    aclHints: {
      externalUser: "user:{Parse objectId}",
      ...(namespaceId
        ? { namespace: toNamespacePrincipal(namespaceId) }
        : {}),
      ...(organizationId
        ? { organization: toOrganizationPrincipal(organizationId) }
        : {}),
    },
    members: members.map(mapMemberForAgent),
  };
}
