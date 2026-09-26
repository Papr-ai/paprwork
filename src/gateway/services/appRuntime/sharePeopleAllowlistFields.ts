import type { CloudPublishAppPrefs } from "../cloudPublishPrefs.js";
import type { SharePeopleAllowlist } from "./cloudAppPeopleAccess.js";

/** Normalize prefs / memory / push payloads into an allowlist (undefined = no restriction). */
export function sharePeopleAllowlistFromFields(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  > | undefined,
): SharePeopleAllowlist | undefined {
  if (!prefs) {
    return undefined;
  }
  const allowedUserIds = prefs.allowedUserIds;
  const allowedEmails = prefs.allowedEmails;
  const allowedEmailDomains = prefs.allowedEmailDomains;
  if (
    (allowedUserIds?.length ?? 0) === 0 &&
    (allowedEmails?.length ?? 0) === 0 &&
    (allowedEmailDomains?.length ?? 0) === 0
  ) {
    return undefined;
  }
  return { allowedUserIds, allowedEmails, allowedEmailDomains };
}
