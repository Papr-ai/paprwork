/**
 * GET /api/members — workspace roster for mini-app role pickers (desktop + cloud).
 */

import {
  fetchWorkspaceMembers,
  resolveWorkspaceIdForContext,
  WorkspaceContextResolutionError,
  type WorkspaceMember,
} from "../../../core/utils/paprWorkspaceTeam.js";
import { createHash } from "node:crypto";
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

type MembersInput = {
  sessionToken: string;
  namespaceId?: string;
  workspaceId?: string;
  workspaceName?: string;
};

/**
 * The roster is a cloud round trip (workspace resolve + members, ~1–2 s) that mini-apps
 * call on every open. It changes rarely, so serve it stale-while-revalidate: fresh for
 * MEMBERS_FRESH_MS, then returned instantly (with one background refresh) until
 * MEMBERS_STALE_MS. Keyed per session token so one user never sees another's roster.
 */
export const MEMBERS_FRESH_MS = 60_000;
export const MEMBERS_STALE_MS = 15 * 60_000;
type MembersEntry = { at: number; value?: MiniAppMembersResponse; inflight?: Promise<MiniAppMembersResponse> };
const membersCache = new Map<string, MembersEntry>();

export function clearMiniAppMembersCache(): void {
  membersCache.clear();
}

function membersCacheKey(input: MembersInput): string {
  const token = createHash("sha256").update(input.sessionToken.trim()).digest("hex").slice(0, 32);
  return [token, input.workspaceId?.trim() ?? "", input.namespaceId?.trim() ?? "", input.workspaceName?.trim() ?? ""].join("|");
}

function refreshMembers(key: string, entry: MembersEntry, input: MembersInput, now: () => number) {
  entry.inflight ??= fetchMiniAppMembers(input)
    .then((value) => {
      entry.value = value;
      entry.at = now();
      return value;
    })
    .finally(() => {
      entry.inflight = undefined;
      if (!entry.value) membersCache.delete(key);
    });
  return entry.inflight;
}

/** Workspace members for a signed-in mini-app caller (cached, see MEMBERS_FRESH_MS). */
export async function listMiniAppMembers(
  input: MembersInput,
  now: () => number = Date.now,
): Promise<MiniAppMembersResponse> {
  if (!input.sessionToken.trim()) return fetchMiniAppMembers(input);
  const key = membersCacheKey(input);
  let entry = membersCache.get(key);
  if (!entry) membersCache.set(key, (entry = { at: 0 }));
  const age = now() - entry.at;
  if (entry.value && age < MEMBERS_FRESH_MS) return entry.value;
  if (entry.value && age < MEMBERS_STALE_MS) {
    void refreshMembers(key, entry, input, now).catch(() => {
      /* keep serving the last good roster; the next call retries */
    });
    return entry.value;
  }
  return refreshMembers(key, entry, input, now);
}

async function fetchMiniAppMembers(input: MembersInput): Promise<MiniAppMembersResponse> {
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
