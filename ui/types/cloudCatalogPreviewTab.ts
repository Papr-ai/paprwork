/**
 * Tab metadata when a Team/Community catalog entry opens live cloud preview in an iframe.
 */

import type { Tab } from "./tabs";

export interface CloudCatalogPreviewTabMetadata {
  cloudCatalogPreview: true;
  previewIframeUrl: string;
  liveUrl: string;
  catalogId: string;
  publisherAppId?: string;
  namespaceId?: string;
  slug?: string | null;
}

export function isCloudCatalogPreviewTab(tab: Tab): boolean {
  return tab.metadata?.cloudCatalogPreview === true;
}

export function readCloudCatalogPreviewTabMetadata(
  tab: Tab,
): CloudCatalogPreviewTabMetadata | null {
  if (!isCloudCatalogPreviewTab(tab)) {
    return null;
  }
  const meta = tab.metadata as Partial<CloudCatalogPreviewTabMetadata>;
  if (typeof meta.previewIframeUrl !== "string" || !meta.previewIframeUrl.trim()) {
    return null;
  }
  if (typeof meta.liveUrl !== "string" || !meta.liveUrl.trim()) {
    return null;
  }
  if (typeof meta.catalogId !== "string" || !meta.catalogId.trim()) {
    return null;
  }
  return {
    cloudCatalogPreview: true,
    previewIframeUrl: meta.previewIframeUrl,
    liveUrl: meta.liveUrl,
    catalogId: meta.catalogId,
    publisherAppId: meta.publisherAppId,
    namespaceId: meta.namespaceId,
    slug: meta.slug ?? null,
  };
}

/** Stable tab entityId for a catalog preview (dedupes re-open). */
export function cloudCatalogPreviewEntityId(catalogId: string): string {
  return `catalog-preview-${catalogId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

export function isCatalogPreviewEntityId(entityId: string): boolean {
  return entityId.startsWith("catalog-preview-");
}

/** Reverse stable entityId → catalogId for cloud entries (cloud:{appId}). */
export function catalogIdFromPreviewEntityId(entityId: string): string | null {
  if (!isCatalogPreviewEntityId(entityId)) {
    return null;
  }
  const encoded = entityId.slice("catalog-preview-".length);
  if (!encoded.startsWith("cloud-")) {
    return null;
  }
  const appId = encoded.slice("cloud-".length);
  if (!appId) {
    return null;
  }
  return `cloud:${appId}`;
}
