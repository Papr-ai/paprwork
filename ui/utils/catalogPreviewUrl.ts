/**
 * Resolve gateway-proxied iframe URL for a cloud catalog entry.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import { currentScheme, mediaForScheme, type Scheme } from "./catalogScheme";
import {
  buildDesktopCloudPreviewUrl,
  desktopGatewayOrigin,
  buildUpstreamPublishedWebUrl,
} from "./cloudDesktopPreview";

export function resolveCatalogPreviewIframeUrl(
  entry: CommunityCatalogEntry,
): string | null {
  if (entry.liveUrl?.trim()) {
    return (
      buildDesktopCloudPreviewUrl(entry.liveUrl.trim()) ?? entry.liveUrl.trim()
    );
  }
  if (entry.namespaceId?.trim() && entry.slug?.trim()) {
    const liveUrl = buildUpstreamPublishedWebUrl({
      sourceNamespaceId: entry.namespaceId.trim(),
      sourceSlug: entry.slug.trim(),
    });
    return buildDesktopCloudPreviewUrl(liveUrl) ?? liveUrl;
  }
  return null;
}

export function resolveCatalogLiveWebUrl(
  entry: CommunityCatalogEntry,
): string | null {
  if (entry.liveUrl?.trim()) {
    return entry.liveUrl.trim();
  }
  if (entry.namespaceId?.trim() && entry.slug?.trim()) {
    return buildUpstreamPublishedWebUrl({
      sourceNamespaceId: entry.namespaceId.trim(),
      sourceSlug: entry.slug.trim(),
    });
  }
  return null;
}

/**
 * Owner-approved cover for a catalog card, served by the cloud host at
 * /{ns}/{slug}/papr-cover (proxied through the desktop gateway). 404 → icon.
 */
/**
 * Memory serves listing media under the app's own access rules, so apps that require
 * sign-in 404 for a plain <img>/<video> (no key). On desktop, ask through the gateway,
 * which calls as the signed-in user and redirects to the signed link.
 */
export function viaDesktopMedia(url: string): string {
  const m = /^https:\/\/[^/]+\/v1\/cloud\/apps\/media\/([^/?#]+)\/([^/?#]+)\/(\d+)(\?poster=1)?$/.exec(url);
  const gw = m && typeof window !== "undefined" && window.electronAPI ? desktopGatewayOrigin() : null;
  return m && gw ? `${gw}/api/cloud/catalog-media/${m[1]}/${m[2]}/${m[3]}${m[4] ?? ""}` : url;
}

export function catalogCoverUrl(entry: CommunityCatalogEntry, scheme: Scheme = currentScheme()): string | null {
  // Stored on the catalog record (memory) — no per-card repo fetch + redirect. Dark-mode viewers get the dark set.
  const stored = mediaForScheme(entry.media, scheme).find((m) => m.role === "cover");
  const poster = stored?.kind === "video" ? stored.posterUrl : stored?.url;
  if (poster) return viaDesktopMedia(poster);
  if (entry.coverUrl) return viaDesktopMedia(entry.coverUrl);
  const live = resolveCatalogLiveWebUrl(entry);
  if (!live) return null;
  const preview = buildDesktopCloudPreviewUrl(live) ?? live;
  try {
    const url = new URL(preview);
    url.pathname = `${url.pathname.replace(/\/?$/, "/")}papr-cover`;
    return url.toString();
  } catch {
    return null;
  }
}

/** Owner-shared preview loop: catalog record first, legacy papr-cover-video route otherwise. */
export function catalogCoverVideoUrl(entry: CommunityCatalogEntry, coverUrl: string | null, scheme: Scheme = currentScheme()): string | null {
  const stored = mediaForScheme(entry.media, scheme).find((m) => m.role === "cover");
  if (stored) return stored.kind === "video" && stored.url ? viaDesktopMedia(stored.url) : null;
  if (entry.coverVideoUrl) return viaDesktopMedia(entry.coverVideoUrl);
  if (entry.coverUrl || !coverUrl) return null; // stored cover with no video → picture only
  return coverUrl.replace(/\/papr-cover(\?|$)/, "/papr-cover-video$1");
}
