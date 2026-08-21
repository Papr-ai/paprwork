/**
 * Route publish/share actions to lightweight memory intents vs full register.
 */

import type { ShareAudienceModel } from "./shareAudienceModel.js";

export interface CloudAppLiveState {
  enabled?: boolean;
  shareUrl?: string | null;
}

/** App has an active memory publish record with a share URL. */
export function isCloudAppLive(state: CloudAppLiveState | null | undefined): boolean {
  return state?.enabled === true && !!state?.shareUrl;
}

/**
 * First-time publish needs code upload when the app will be hosted on the web
 * (view/interact/community). Desktop-only private install skips web upload.
 */
export function audienceModelNeedsInitialCodeUpload(
  model: ShareAudienceModel,
  isLive: boolean,
): boolean {
  if (isLive) {
    return false;
  }
  return !(model.audience === "private" && model.permission === "edit");
}

/** Sharing change on a live app is ACL-only — no code/DB upload required. */
export function sharingChangeIsAclOnly(isLive: boolean): boolean {
  return isLive;
}
