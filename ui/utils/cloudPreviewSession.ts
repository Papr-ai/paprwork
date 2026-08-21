/**
 * Bootstrap apps.papr.ai cookies for direct iframe preview (desktop only).
 */

import {
  buildDesktopCloudPreviewUrl,
  isDesktopElectron,
} from "./cloudDesktopPreview";

export interface CloudPreviewSessionTarget {
  namespaceId: string;
  slug: string;
  shareToken?: string;
  liveUrl: string;
}

export type CloudPreviewIframeMode = "direct" | "proxy";

export interface CloudPreviewIframeResolution {
  iframeUrl: string;
  mode: CloudPreviewIframeMode;
}

const prefetchInFlight = new Set<string>();

function previewTargetKey(target: CloudPreviewSessionTarget): string {
  return `${target.namespaceId}:${target.slug}:${target.shareToken ?? ""}`;
}

/** Warm session cookies before the user clicks Open (desktop only). */
export function prefetchCloudPreviewSession(
  target: CloudPreviewSessionTarget,
): void {
  const key = previewTargetKey(target);
  if (prefetchInFlight.has(key)) {
    return;
  }
  prefetchInFlight.add(key);
  void prepareCloudPreviewIframe(target).finally(() => {
    prefetchInFlight.delete(key);
  });
}

export async function prepareCloudPreviewIframe(
  target: CloudPreviewSessionTarget,
): Promise<CloudPreviewIframeResolution> {
  const proxyUrl =
    buildDesktopCloudPreviewUrl(target.liveUrl) ?? target.liveUrl;

  if (!isDesktopElectron() || !window.electronAPI?.cloudPreview?.seedSession) {
    return { iframeUrl: proxyUrl, mode: "proxy" };
  }

  const seeded = await window.electronAPI.cloudPreview.seedSession({
    namespaceId: target.namespaceId,
    slug: target.slug,
    shareToken: target.shareToken,
  });

  if (seeded.success) {
    return { iframeUrl: target.liveUrl, mode: "direct" };
  }

  console.warn(
    "[CloudPreview] Session seed failed — falling back to gateway proxy:",
    seeded.error,
  );
  return { iframeUrl: proxyUrl, mode: "proxy" };
}
