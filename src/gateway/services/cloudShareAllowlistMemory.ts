/**
 * Share-audience allowlists on the Memory publish document (defense in depth with
 * gateway / Cloud App Host enforcement).
 */

import {
  normalizeAllowedEmailDomains,
  normalizeAllowedEmails,
  normalizeAllowedUserIds,
} from "../../core/utils/shareAudienceModel.js";
import type { CloudPublishAppPrefs } from "./cloudPublishPrefs.js";

export interface MemoryShareAllowlistBody {
  allowedUserIds: string[];
  allowedEmails: string[];
  allowedEmailDomains: string[];
}

export function memoryShareAllowlistBodyFromPrefs(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): MemoryShareAllowlistBody {
  return {
    allowedUserIds: normalizeAllowedUserIds(prefs.allowedUserIds),
    allowedEmails: normalizeAllowedEmails(prefs.allowedEmails),
    allowedEmailDomains: normalizeAllowedEmailDomains(prefs.allowedEmailDomains),
  };
}

export function prefsPeopleAllowlistChanged(
  update: Partial<CloudPublishAppPrefs>,
): boolean {
  return (
    update.allowedUserIds !== undefined ||
    update.allowedEmails !== undefined ||
    update.allowedEmailDomains !== undefined
  );
}
