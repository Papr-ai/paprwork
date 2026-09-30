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
