/**
 * Audience "people" — share a mini-app with named workspace users and/or
 * signed-in guests by email or domain.
 *
 * Why this file exists at all:
 *
 * "people" is usually published with the *team* cloud ACL, because the memory
 * server has no per-user principal for app publishing. That means the cloud has
 * already answered "yes" for every member of the workspace by the time a
 * request reaches us. When external emails/domains are listed, publish uses
 * loginAccess "public" + requireSignIn instead — still narrowed here.
 *
 * So this is a security boundary, not a presentation detail. It has to run on
 * the server, before canRead/canWrite are consulted by /api/db/query and
 * /api/db/write — a hidden menu item would leave the data readable to any
 * signed-in colleague with devtools.
 */

import {
  isUserAllowedByAudienceModel,
  normalizeAllowedEmailDomains,
  normalizeAllowedEmails,
  normalizeAllowedUserIds,
  shareAudienceHasPeopleRestriction,
} from "../../../core/utils/shareAudienceModel.js";
import type { AppAccessContext } from "./types.js";

export interface SharePeopleAllowlist {
  allowedUserIds?: readonly string[];
  allowedEmails?: readonly string[];
  allowedEmailDomains?: readonly string[];
}

export interface PeopleAccessCaller {
  userId?: string;
  email?: string;
}

export interface PeopleAccessDecision {
  /** Access after the allowlist is applied. */
  access: AppAccessContext;
  /** True when the caller was rejected by the allowlist. */
  denied: boolean;
  /** Set when denied, for the 403 body and logs. */
  reason?: "not_in_allowlist" | "sign_in_required";
}

/**
 * Narrow an app's access to an explicit audience list.
 *
 * An empty list is *not* "deny everyone" — it is the absence of a list, which
 * means the app is shared with the whole workspace ("team"). Treating empty as
 * deny-all would silently break every already-published team app the moment
 * this field is introduced.
 */
export function applyPeopleAllowlist(
  access: AppAccessContext,
  allowlist: SharePeopleAllowlist | readonly string[] | undefined,
  callerUserId: string | undefined,
  callerEmail?: string,
): PeopleAccessDecision {
  const normalizedAllowlist = normalizeSharePeopleAllowlist(allowlist);
  if (!shareAudienceHasPeopleRestriction(normalizedAllowlist)) {
    return { access, denied: false };
  }

  // The publisher opening their own app in Paprwork is already resolved as
  // owner. Re-checking would lock authors out of apps they forgot to add
  // themselves to.
  if (access.mode === "owner") {
    return { access, denied: false };
  }

  const caller = callerUserId?.trim();
  const email = callerEmail?.trim();
  if (!caller && !email) {
    return {
      access: denyAccess(access),
      denied: true,
      reason: "sign_in_required",
    };
  }

  const permitted = isUserAllowedByAudienceModel(
    { audience: "people", ...normalizedAllowlist },
    caller,
    access.userId,
    email,
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

type NormalizedPeopleAllowlist = {
  allowedUserIds?: string[];
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
};

function isLegacyAllowedUserIdList(
  allowlist: SharePeopleAllowlist | readonly string[],
): allowlist is readonly string[] {
  return Array.isArray(allowlist);
}

function normalizeSharePeopleAllowlist(
  allowlist: SharePeopleAllowlist | readonly string[] | undefined,
): NormalizedPeopleAllowlist {
  if (!allowlist) {
    return {};
  }
  if (isLegacyAllowedUserIdList(allowlist)) {
    return { allowedUserIds: normalizeAllowedUserIds([...allowlist]) };
  }
  const record = allowlist;
  const ids = record.allowedUserIds;
  const emails = record.allowedEmails;
  const domains = record.allowedEmailDomains;
  return {
    allowedUserIds: normalizeAllowedUserIds(ids ? [...ids] : undefined),
    allowedEmails: normalizeAllowedEmails(emails ? [...emails] : undefined),
    allowedEmailDomains: normalizeAllowedEmailDomains(
      domains ? [...domains] : undefined,
    ),
  };
}

/**
 * Strip every capability rather than only the one being exercised, so a denial
 * cannot be converted into partial access by switching endpoints.
 */
function denyAccess(access: AppAccessContext): AppAccessContext {
  return { ...access, canRead: false, canWrite: false };
}

/** True when the app is restricted to a named set of users, emails, or domains. */
export function isPeopleRestricted(
  allowlist: SharePeopleAllowlist | readonly string[] | undefined,
): boolean {
  return shareAudienceHasPeopleRestriction(normalizeSharePeopleAllowlist(allowlist));
}
