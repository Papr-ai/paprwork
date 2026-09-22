/**
 * Audience "people" — share a mini-app with named workspace users.
 *
 * Why this file exists at all:
 *
 * "people" is published with the *team* cloud ACL, because the memory server
 * has no per-user principal for app publishing. That means the cloud has
 * already answered "yes" for every member of the workspace by the time a
 * request reaches us. This module is the only thing that turns that into
 * "yes, for these people".
 *
 * So this is a security boundary, not a presentation detail. It has to run on
 * the server, before canRead/canWrite are consulted by /api/db/query and
 * /api/db/write — a hidden menu item would leave the data readable to any
 * signed-in colleague with devtools.
 */

import {
  isUserAllowedByAudienceModel,
  normalizeAllowedUserIds,
} from "../../../core/utils/shareAudienceModel.js";
import type { AppAccessContext } from "./types.js";

export interface PeopleAccessDecision {
  /** Access after the allowlist is applied. */
  access: AppAccessContext;
  /** True when the caller was rejected by the allowlist. */
  denied: boolean;
  /** Set when denied, for the 403 body and logs. */
  reason?: "not_in_allowlist" | "sign_in_required";
}

/**
 * Narrow an app's access to an explicit list of workspace users.
 *
 * An empty list is *not* "deny everyone" — it is the absence of a list, which
 * means the app is shared with the whole workspace ("team"). Treating empty as
 * deny-all would silently break every already-published team app the moment
 * this field is introduced.
 */
export function applyPeopleAllowlist(
  access: AppAccessContext,
  allowedUserIds: readonly string[] | undefined,
  callerUserId: string | undefined,
): PeopleAccessDecision {
  const allowed = normalizeAllowedUserIds(
    allowedUserIds as string[] | undefined,
  );
  if (allowed.length === 0) {
    return { access, denied: false };
  }

  // The publisher opening their own app in Paprwork is already resolved as
  // owner. Re-checking would lock authors out of apps they forgot to add
  // themselves to.
  if (access.mode === "owner") {
    return { access, denied: false };
  }

  const caller = callerUserId?.trim();
  if (!caller) {
    return {
      access: denyAccess(access),
      denied: true,
      reason: "sign_in_required",
    };
  }

  const permitted = isUserAllowedByAudienceModel(
    { audience: "people", allowedUserIds: allowed },
    caller,
    access.userId,
  );
  if (permitted) {
    return { access, denied: false };
  }

  return {
    access: denyAccess(access),
    denied: true,
    reason: "not_in_allowlist",
  };
}

/**
 * Strip every capability rather than only the one being exercised, so a denial
 * cannot be converted into partial access by switching endpoints.
 */
function denyAccess(access: AppAccessContext): AppAccessContext {
  return { ...access, canRead: false, canWrite: false };
}

/** True when the app is restricted to a named set of users. */
export function isPeopleRestricted(
  allowedUserIds: readonly string[] | undefined,
): boolean {
  return normalizeAllowedUserIds(allowedUserIds as string[] | undefined).length > 0;
}
