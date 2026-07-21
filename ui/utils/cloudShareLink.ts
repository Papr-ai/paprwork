/**
 * Format cloud mini-app share URLs (link modes append ?t= token).
 */

export type CloudShareAccessMode =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export type CloudLoginAccess = "private" | "team" | "public" | "none";
export type CloudExternalLink = "off" | "read" | "read_write";

export function accessModeToSharingSettings(accessMode: CloudShareAccessMode): {
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
} {
  switch (accessMode) {
    case "team":
      return { loginAccess: "team", externalLink: "off" };
    case "public_read":
      return { loginAccess: "public", externalLink: "off" };
    case "link_read":
      return { loginAccess: "none", externalLink: "read" };
    case "link_read_write":
      return { loginAccess: "none", externalLink: "read_write" };
    case "private":
    default:
      return { loginAccess: "private", externalLink: "off" };
  }
}

export function sharingSettingsRequireShareToken(input: {
  externalLink?: CloudExternalLink;
  accessMode?: string;
}): boolean {
  if (input.externalLink !== undefined) {
    return input.externalLink !== "off";
  }
  return accessModeRequiresShareToken(input.accessMode);
}

function isPublishedAppRootPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2;
}

function ensurePublishedAppRootTrailingSlash(pathname: string): string {
  if (!isPublishedAppRootPath(pathname)) {
    return pathname;
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function normalizeCloudShareUrl(shareUrl: string): string {
  try {
    const url = new URL(shareUrl);
    url.pathname = ensurePublishedAppRootTrailingSlash(url.pathname);
    return url.toString();
  } catch {
    const qIndex = shareUrl.indexOf("?");
    const path = qIndex === -1 ? shareUrl : shareUrl.slice(0, qIndex);
    const query = qIndex === -1 ? "" : shareUrl.slice(qIndex);
    return `${ensurePublishedAppRootTrailingSlash(path)}${query}`;
  }
}

export function accessModeRequiresShareToken(
  accessMode: string | undefined,
): boolean {
  return accessMode === "link_read" || accessMode === "link_read_write";
}

export function formatShareLink(
  shareUrl: string | null | undefined,
  shareToken: string | null | undefined,
  accessMode: string | undefined,
  externalLinkEnabled?: boolean,
): string | null {
  if (!shareUrl) return null;
  const normalizedUrl = normalizeCloudShareUrl(shareUrl);
  const appendToken =
    externalLinkEnabled === true ||
    (externalLinkEnabled !== false && accessModeRequiresShareToken(accessMode));
  if (appendToken && shareToken) {
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
