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
