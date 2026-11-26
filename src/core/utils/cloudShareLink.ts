/**
 * Format cloud mini-app share URLs (link modes append ?t= token).
 */

import { normalizeCloudShareUrl } from "./cloudAppPath.js";

export type CloudShareAccessMode =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export function accessModeRequiresShareToken(
  accessMode: string | undefined,
): boolean {
  return accessMode === "link_read" || accessMode === "link_read_write";
}

/** Append ?t= when external link sharing is enabled and a token exists. */
export function shouldAppendShareToken(
  accessMode: string | undefined,
  externalLinkEnabled?: boolean,
): boolean {
  if (externalLinkEnabled === true) {
    return true;
  }
  if (externalLinkEnabled === false) {
    return false;
  }
  return accessModeRequiresShareToken(accessMode);
}

export function formatShareLink(
  shareUrl: string | null | undefined,
  shareToken: string | null | undefined,
  accessMode: string | undefined,
  externalLinkEnabled?: boolean,
): string | null {
  if (!shareUrl) return null;
  const normalizedUrl = normalizeCloudShareUrl(shareUrl);
  if (shouldAppendShareToken(accessMode, externalLinkEnabled) && shareToken) {
    try {
      const url = new URL(normalizedUrl);
      url.searchParams.set("t", shareToken);
      return url.toString();
    } catch {
      const sep = normalizedUrl.includes("?") ? "&" : "?";
      return `${normalizedUrl}${sep}t=${encodeURIComponent(shareToken)}`;
    }
  }
  return normalizedUrl;
}

export interface ShareLinkAudiences {
  /** Share-sheet roles: "none" when that audience is off. */
  workspace?: string;
  link?: string;
  community?: string;
  requireSignIn?: boolean;
}

export interface PickedShareLink {
  /** The one URL to give people. Includes ?t= when only the link grants access. */
  shareLink: string | null;
  /** Who can open shareLink, in plain words (tell the user when it matters). */
  shareLinkWho: string;
}

/**
 * The link to hand out for an app, chosen from its current access settings.
 * Agents (Pen over SMS especially) pasted the bare app URL for link-only apps,
 * which shows "Invite link required". Anyone-with-the-link → tokened URL;
 * Community → plain URL; Workspace → plain URL (teammates sign in);
 * nothing open → plain URL, owner only.
 */
export function pickShareLink(
  shareUrl: string | null | undefined,
  shareToken: string | null | undefined,
  a: ShareLinkAudiences | null | undefined,
): PickedShareLink {
  if (!shareUrl) return { shareLink: null, shareLinkWho: "Not published yet" };
  const base = normalizeCloudShareUrl(shareUrl.split("?")[0]);
  const on = (r?: string) => Boolean(r) && r !== "none";
  if (on(a?.link)) {
    if (!shareToken) {
      return { shareLink: null, shareLinkWho: "Link sharing is on but there is no link token yet — republish before sharing" };
    }
    return {
      shareLink: formatShareLink(base, shareToken, undefined, true),
      shareLinkWho: "Anyone with this exact link",
    };
  }
  if (on(a?.community)) {
    return {
      shareLink: base,
      shareLinkWho: a?.requireSignIn ? "Anyone, after signing in to Papr" : "Anyone (listed in Community)",
    };
  }
  if (on(a?.workspace)) return { shareLink: base, shareLinkWho: "Workspace members, after signing in" };
  return { shareLink: base, shareLinkWho: "Only you (sign in). To share it, turn on link sharing first" };
}
