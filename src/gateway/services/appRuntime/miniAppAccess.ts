/**
 * Shared helpers for GET /api/access (local gateway + cloud app host).
 */

import type {
  AppAccessContext,
  MiniAppAccessResponse,
} from "./types.js";

export function buildMiniAppAccessResponse(
  access: AppAccessContext | null,
  loggedIn: boolean,
  appId?: string,
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

  return {
    mode: access.mode,
    canRead: access.canRead,
    canWrite: access.canWrite,
    loggedIn,
    isOwner: access.mode === "owner",
    appId: access.appId,
  };
}

/** Desktop Paprwork iframe — always owner with full read/write. */
export function buildLocalDesktopAccessResponse(appId: string): MiniAppAccessResponse {
  return {
    mode: "owner",
    canRead: true,
    canWrite: true,
    loggedIn: true,
    isOwner: true,
    appId,
  };
}
