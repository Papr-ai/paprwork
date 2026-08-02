/**
 * Build gateway-proxied cloud preview URLs for Paprwork desktop.
 */

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export function isDesktopElectron(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI !== "undefined";
}

export function parsePublishedAppUrl(url: string): {
  namespaceId: string;
  slug: string;
  shareToken?: string;
} | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const namespaceId = segments[0];
    const slug = segments[1];
    const shareToken = parsed.searchParams.get("t") ?? undefined;
    return { namespaceId, slug, shareToken };
  } catch {
    return null;
  }
}

export function buildDesktopCloudPreviewUrl(publishedUrl: string): string | null {
  const parsed = parsePublishedAppUrl(publishedUrl);
  if (!parsed) return null;
  const query = parsed.shareToken
    ? `?t=${encodeURIComponent(parsed.shareToken)}`
    : "";
  return `${GATEWAY}/cloud-preview/${parsed.namespaceId}/${parsed.slug}/${query}`;
}

/** Clear stale cloud-preview cookies so Local mode uses local SQLite again. */
export function clearCloudPreviewCookies(): void {
  const names = ["papr_cloud_preview", "papr_cloud_ns", "papr_cloud_slug"];
  for (const name of names) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}
