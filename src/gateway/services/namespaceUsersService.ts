/**
 * List Papr workspace members for agent-driven memory ACL decisions.
 */

import {
  fetchWorkspaceMembers,
  type WorkspaceMember,
} from "../../core/utils/paprWorkspaceTeam.js";
import {
  toExternalUserPrincipal,
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
    memoryReadPrincipal: toExternalUserPrincipal(externalUserId),
  };
}

export async function listNamespaceUsersForAgent(): Promise<ListNamespaceUsersResult> {
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  if (!sessionToken) {
    throw new Error(
      "PAPR_SESSION_TOKEN is not configured. Sign in with Papr to list workspace members.",
    );
  }

  const workspaceId = getPaprWorkspaceId();
  if (!workspaceId) {
    throw new Error(
      "No Papr workspace id is available. Sign out and sign in again to refresh workspace metadata.",
    );
  }

  const pointer = readActiveWorkspacePointer();
  const profile = getGatewayPaprProfile();
  const recorderExternalUserId = getPaprUserId();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
  const organizationId =
    process.env.PAPR_ORG_ID?.trim() || pointer?.organizationId;

  const members = await fetchWorkspaceMembers(sessionToken, workspaceId);

  return {
    workspaceId,
    workspaceName: profile.paprWorkspaceName,
    namespaceId,
    organizationId,
    recorderExternalUserId,
    aclHints: {
      externalUser: "external_user:{Parse objectId}",
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
