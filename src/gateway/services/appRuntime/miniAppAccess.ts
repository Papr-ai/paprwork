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

export interface MiniAppCallerIdentity {
  /** Parse _User.objectId — same value as externalUserId on cloud. */
  userId?: string;
  email?: string;
}

function resolveIsOwner(
  access: AppAccessContext,
  callerUserId?: string,
): boolean {
  if (access.mode === "owner") {
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
