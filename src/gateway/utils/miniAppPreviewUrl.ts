/**
 * Resolve mini-app preview URLs for agent webview sessions (local vs published/web).
 */

import type { CloudPublishConfig } from "../services/CloudAppPublishService.js";
import { getCloudAppPublishService } from "../services/CloudAppPublishService.js";
import {
  getAppPublishPrefs,
  type CloudPublishAppPrefs,
} from "../services/cloudPublishPrefs.js";
import {
  formatShareLink,
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
} from "../services/cloudPublishMapping.js";
import { buildDesktopCloudPreviewUrl } from "../services/appRuntime/cloudDesktopPreviewProxy.js";

export type MiniAppPreviewTarget = "local" | "published";

export interface MiniAppPreviewLaunchResolution {
  previewTarget: MiniAppPreviewTarget;
  url: string;
  /** Public apps.papr.ai URL when previewTarget is published. */
  publishedWebUrl?: string;
}

function gatewayBaseUrl(): string {
  const host = process.env.GATEWAY_HOST ?? "localhost";
  const port = process.env.GATEWAY_PORT ?? "18789";
  return `http://${host}:${port}`;
}

export function buildLocalMiniAppPreviewUrl(
  gatewayBase: string,
  appId: string,
): string {
  const base = gatewayBase.replace(/\/$/, "");
  return `${base}/apps/${encodeURIComponent(appId)}/index.html`;
}

/** Mirror ui/hooks/useCloudPublish publishedWebUrl selection. */
export function resolvePublishedWebUrlForPreview(
  config: CloudPublishConfig,
  prefs: CloudPublishAppPrefs,
): string | null {
  if (!config.enabled || !config.shareUrl) {
    return null;
  }

  const sharing = resolveSharingSettings(prefs);
  const token = config.shareToken ?? prefs.shareToken ?? null;
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  const baseUrl = config.shareUrl;
  const shareLink =
    formatShareLink(baseUrl, token, config.accessMode, externalEnabled) ??
    baseUrl;
  const externalLinkUrl =
    externalEnabled && shareLink.includes("?t=") ? shareLink : null;
  const loginUrl =
    sharing.loginAccess === "none"
      ? null
      : externalLinkUrl
        ? baseUrl
        : (shareLink ?? baseUrl);

  return externalLinkUrl ?? loginUrl ?? shareLink ?? baseUrl;
}

export async function resolveMiniAppPreviewLaunch(
  appId: string,
  previewTarget: MiniAppPreviewTarget = "local",
): Promise<MiniAppPreviewLaunchResolution> {
  const gatewayBase = gatewayBaseUrl();

  if (previewTarget === "local") {
    return {
      previewTarget: "local",
      url: buildLocalMiniAppPreviewUrl(gatewayBase, appId),
    };
  }

  const prefs = getAppPublishPrefs(appId);
  if (prefs.cloudEnabled === false) {
    throw new Error(
      `App "${appId}" is local-only (cloud sync disabled). Use previewTarget: "local" or enable cloud for this app.`,
    );
  }

  const config = await getCloudAppPublishService().getPublishConfig(appId);
  const publishedWebUrl = resolvePublishedWebUrlForPreview(config, prefs);
  if (!publishedWebUrl) {
    throw new Error(
      `App "${appId}" is not published to the web yet. Publish first (publish_cloud_app) or use previewTarget: "local".`,
    );
  }

  const proxyUrl = buildDesktopCloudPreviewUrl(gatewayBase, publishedWebUrl);
  if (!proxyUrl) {
    throw new Error(
      `Could not build cloud preview URL for app "${appId}". Check publish slug and namespace.`,
    );
  }

  return {
    previewTarget: "published",
    url: proxyUrl,
    publishedWebUrl,
  };
}
