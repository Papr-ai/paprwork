/**
 * Shared helpers for GET /api/access (local gateway + cloud app host).
 */

import type {
  AppAccessContext,
  MiniAppAccessResponse,
} from "./types.js";

/** Server-injected job env vars — override any client-supplied identity params. */
export const VERIFIED_CALLER_USER_ID_PARAM = "PAPR_CALLER_USER_ID";
export const VERIFIED_CALLER_EMAIL_PARAM = "PAPR_CALLER_EMAIL";
/** App share role of the verified caller (viewer|contributor|maintainer|admin). */
export const VERIFIED_CALLER_ROLE_ENV = "PAPR_CALLER_ROLE";
/** "1" when the verified caller is in the publisher's workspace team. */
export const VERIFIED_CALLER_TEAM_ENV = "PAPR_CALLER_TEAM_MEMBER";

export const APP_ROLES = ["viewer", "contributor", "maintainer", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function normalizeAppRole(raw: unknown): AppRole | undefined {
  const r = String(raw ?? "").trim().toLowerCase();
  return (APP_ROLES as readonly string[]).includes(r) ? (r as AppRole) : undefined;
}

/** Server-resolved role + team membership for row ACL principals. */
export interface MiniAppCallerAccess {
  role?: string;
  teamMember?: boolean;
}

/** Workspace team = publisher ("owner") or a namespace member ("team"). Named people are not. */
export function isTeamAccessMode(mode: string | null | undefined): boolean {
  return mode === "owner" || mode === "team";
}

export interface MiniAppCallerIdentity {
  /** Parse _User.objectId — same value as externalUserId on cloud. */
  userId?: string;
  email?: string;
}

export function resolveIsOwner(
  access: AppAccessContext,
  callerUserId?: string,
): boolean {
  if (access.mode === "owner" || access.role === "admin") {
    return true;
  }
  const caller = callerUserId?.trim();
  const publisher = access.userId.trim();
  return Boolean(caller && caller === publisher);
}

export function buildMiniAppAccessResponse(
  access: AppAccessContext | null,
  loggedIn: boolean,
  appId?: string,
  identity?: MiniAppCallerIdentity,
): MiniAppAccessResponse {
  if (!access) {
    return {
      mode: null,
      canRead: false,
      canWrite: false,
      loggedIn,
      isOwner: false,
      ...(appId ? { appId } : {}),
    };
  }

  const callerUserId = identity?.userId?.trim();
  const email = identity?.email?.trim();
  const publisherUserId = access.userId;
  const isOwner = resolveIsOwner(access, callerUserId);

  const base: MiniAppAccessResponse = {
    mode: access.mode,
    canRead: access.canRead,
    canWrite: access.canWrite,
    loggedIn,
    isOwner,
    ...(access.role ? { role: access.role } : {}),
    appId: access.appId,
    publisherUserId,
  };

  if (!loggedIn || !callerUserId) {
    return base;
  }

  return {
    ...base,
    userId: callerUserId,
    externalUserId: callerUserId,
    ...(email ? { email } : {}),
  };
}

/** Desktop Paprwork iframe — always owner with full read/write. */
export function buildLocalDesktopAccessResponse(
  appId: string,
  identity?: MiniAppCallerIdentity,
): MiniAppAccessResponse {
  const callerUserId = identity?.userId?.trim();
  const email = identity?.email?.trim();
  return {
    mode: "owner",
    canRead: true,
    canWrite: true,
    loggedIn: true,
    isOwner: true,
    appId,
    ...(callerUserId
      ? {
          userId: callerUserId,
          externalUserId: callerUserId,
          publisherUserId: callerUserId,
        }
      : {}),
    ...(email ? { email } : {}),
  };
}

/** Merge verified caller identity into job params (server wins over client). */
export function mergeVerifiedCallerJobParams(
  clientParams: Record<string, string> | undefined,
  loggedIn: boolean,
  identity?: MiniAppCallerIdentity,
): Record<string, string> | undefined {
  if (!loggedIn) {
    return clientParams;
  }
  const userId = identity?.userId?.trim();
  if (!userId) {
    return clientParams;
  }
  const email = identity?.email?.trim();
  return {
    ...clientParams,
    [VERIFIED_CALLER_USER_ID_PARAM]: userId,
    ...(email ? { [VERIFIED_CALLER_EMAIL_PARAM]: email } : {}),
  };
}
