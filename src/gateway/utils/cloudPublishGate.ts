/**
 * Gate cloud publish/install tools — prefer cloud path, clear fallback to export.
 */

import { loadSettings } from "../websocket/settings.js";
import { getPaprApiKey } from "./keyResolver.js";

export interface CloudPublishUnavailable {
  available: false;
  error: string;
  fallbackTool: "export_app_bundle";
  recommendation: string;
}

export type CloudPublishAvailability =
  | { available: true }
  | CloudPublishUnavailable;

const EXPORT_FALLBACK =
  "Use export_app_bundle and open a PR to paprwork-community-apps (works without Cloud Sync).";

const CLOUD_RECOMMENDATION =
  "Recommend enabling Cloud Sync (Settings → Cloud Sync) and signing in with Papr — live hosting, Community catalog, and fork/install are a better experience than GitHub export alone.";

export async function checkCloudPublishAvailable(): Promise<CloudPublishAvailability> {
  const settings = await loadSettings();
  if (settings.preferences.cloudSyncEnabled === false) {
    return {
      available: false,
      error:
        "Cloud Sync is disabled. Enable it in Settings → Cloud Sync to publish on apps.papr.ai.",
      fallbackTool: "export_app_bundle",
      recommendation: `${CLOUD_RECOMMENDATION} ${EXPORT_FALLBACK}`,
    };
  }

  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return {
      available: false,
      error:
        "Papr login required. Sign in under Settings → Papr Account before using cloud publish tools.",
      fallbackTool: "export_app_bundle",
      recommendation: `${CLOUD_RECOMMENDATION} ${EXPORT_FALLBACK}`,
    };
  }

  return { available: true };
}

export async function requireCloudPublishAvailable(): Promise<void> {
  const check = await checkCloudPublishAvailable();
  if (!check.available) {
    throwCloudPublishUnavailable(check);
  }
}

export async function requirePaprCloudLogin(): Promise<void> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throwCloudPublishUnavailable({
      available: false,
      error:
        "Papr login required. Sign in under Settings → Papr Account before using this cloud tool.",
      fallbackTool: "export_app_bundle",
      recommendation: `${CLOUD_RECOMMENDATION} ${EXPORT_FALLBACK}`,
    });
  }
}

export function throwCloudPublishUnavailable(details: CloudPublishUnavailable): never {
  throw new Error(
    JSON.stringify({
      success: false,
      error: details.error,
      fallbackTool: details.fallbackTool,
      recommendation: details.recommendation,
      timestamp: new Date().toISOString(),
    }),
  );
}
