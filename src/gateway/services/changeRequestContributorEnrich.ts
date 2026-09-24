/**
 * Load workspace members and enrich incoming change requests with display names.
 */

import {
  buildMemberLookupByUserId,
  enrichChangeRequestContributorList,
  type ContributorMemberLookup,
} from "../../core/utils/changeRequestContributorEnrich.js";
import {
  fetchWorkspaceMembers,
  resolveWorkspaceIdForContext,
} from "../../core/utils/paprWorkspaceTeam.js";
import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import { getApiKey } from "../utils/keyResolver.js";
import { getPaprWorkspaceId } from "../utils/paprGatewayProfile.js";

let cachedMembers: Map<string, ContributorMemberLookup> | null = null;
let cachedMembersAt = 0;
const MEMBER_CACHE_TTL_MS = 60_000;

export async function getWorkspaceContributorMemberLookup(): Promise<
  Map<string, ContributorMemberLookup>
> {
  const now = Date.now();
  if (cachedMembers && now - cachedMembersAt < MEMBER_CACHE_TTL_MS) {
    return cachedMembers;
  }

  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  if (!sessionToken) {
    return new Map();
  }

  const pointer = readActiveWorkspacePointer();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;

  let workspaceId = getPaprWorkspaceId();
  if (!workspaceId) {
    workspaceId = await resolveWorkspaceIdForContext(sessionToken, {
      namespaceId,
    });
  }
  if (!workspaceId) {
    return new Map();
  }

  try {
    const members = await fetchWorkspaceMembers(sessionToken, workspaceId);
    const map = buildMemberLookupByUserId(
      members.map((m) => ({
        externalUserId: m.user.objectId,
        user: {
          objectId: m.user.objectId,
          displayName: m.user.displayName,
          email: m.user.email,
        },
      })),
    );
    cachedMembers = map;
    cachedMembersAt = now;
    return map;
  } catch (err) {
    console.warn(
      "[ChangeRequestEnrich] Failed to load workspace members:",
      (err as Error).message,
    );
    return new Map();
  }
}

export async function enrichIncomingChangeRequestsBody(
  body: unknown,
): Promise<unknown> {
  if (!body || typeof body !== "object") {
    return body;
  }
  const record = body as { requests?: unknown[] };
  if (!Array.isArray(record.requests) || record.requests.length === 0) {
    return body;
  }

  const members = await getWorkspaceContributorMemberLookup();

  return {
    ...record,
    requests: enrichChangeRequestContributorList(record.requests, members),
  };
}
