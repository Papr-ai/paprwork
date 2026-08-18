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
  userId?: string;
  email?: string;
}

function appendCallerIdentity(
  response: MiniAppAccessResponse,
  loggedIn: boolean,
  identity?: MiniAppCallerIdentity,
): MiniAppAccessResponse {
  if (!loggedIn) {
    return response;
  }
  const userId = identity?.userId?.trim();
  const email = identity?.email?.trim();
  return {
    ...response,
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
  };
}

export function buildMiniAppAccessResponse(
  access: AppAccessContext | null,
  loggedIn: boolean,
  appId?: string,
  identity?: MiniAppCallerIdentity,
): MiniAppAccessResponse {
  if (!access) {
    return appendCallerIdentity(
      {
        mode: null,
        canRead: false,
        canWrite: false,
        loggedIn,
        isOwner: false,
        ...(appId ? { appId } : {}),
      },
      loggedIn,
      identity,
    );
  }

  return appendCallerIdentity(
    {
      mode: access.mode,
      canRead: access.canRead,
      canWrite: access.canWrite,
      loggedIn,
      isOwner: access.mode === "owner",
      appId: access.appId,
    },
    loggedIn,
    { userId: access.userId, ...identity },
  );
}

/** Desktop Paprwork iframe — always owner with full read/write. */
export function buildLocalDesktopAccessResponse(
  appId: string,
  identity?: MiniAppCallerIdentity,
): MiniAppAccessResponse {
  return appendCallerIdentity(
    {
      mode: "owner",
      canRead: true,
      canWrite: true,
      loggedIn: true,
      isOwner: true,
      appId,
    },
    true,
    identity,
  );
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
