/**
 * Resolve gateway-proxied iframe URL for a cloud catalog entry.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import {
  buildDesktopCloudPreviewUrl,
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
export function catalogCoverUrl(entry: CommunityCatalogEntry): string | null {
  // Stored on the catalog record (memory) — no per-card repo fetch + redirect.
  if (entry.coverUrl) return entry.coverUrl;
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
export function catalogCoverVideoUrl(entry: CommunityCatalogEntry, coverUrl: string | null): string | null {
  if (entry.coverVideoUrl) return entry.coverVideoUrl;
  if (entry.coverUrl || !coverUrl) return null; // stored cover with no video → picture only
  return coverUrl.replace(/\/papr-cover(\?|$)/, "/papr-cover-video$1");
}
