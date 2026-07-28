/**
 * Cloud link status for Settings UI.
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import {
  getCloudAppPublishService,
  type CloudPublishConfig,
} from "./CloudAppPublishService.js";
import { isCloudAutoPublishGloballyEnabled } from "./cloudAutoPublishSettings.js";
import { getAppPublishPrefs, type CloudAccessMode } from "./cloudPublishPrefs.js";
import { formatShareLink } from "../../core/utils/cloudShareLink.js";
import {
  memoryPublishResponseToConfig,
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
} from "./cloudPublishMapping.js";

import type {
  CloudExternalLink,
  CloudLoginAccess,
} from "./cloudSharingSettings.js";

export interface CloudLinkSyncItem {
  appId: string;
  label: string;
  enabled: boolean;
  /** Base URL from memory server (no token). */
  shareUrl: string | null;
  /** URL to copy/open — includes ?t= when external link is enabled. */
  shareLink: string | null;
  shareToken: string | null;
  accessMode: CloudAccessMode;
  loginAccess: CloudLoginAccess;
  externalLink: CloudExternalLink;
  autoPublish: boolean;
  status: "live" | "pending" | "disabled" | "unavailable";
  lastError: string | null;
}

export interface CloudLinkSyncReport {
  enabled: boolean;
  /** Global Settings toggle — when false, auto-publish is off for all apps. */
  globalAutoPublishEnabled: boolean;
  appsHost: string;
  error: string | null;
  items: CloudLinkSyncItem[];
  summary: {
    live: number;
    pending: number;
    disabled: number;
    unavailable: number;
    total: number;
  };
}

function loadAppTitles(paprDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as
      | Array<{ id: string; title?: string }>
      | Record<string, { id: string; title?: string }>;
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const app of list) {
      if (app.id) {
        titles.set(app.id, app.title?.trim() || app.id.slice(0, 8));
      }
    }
  } catch {
    /* optional */
  }
  return titles;
}

function resolveStatus(
  config: Pick<CloudPublishConfig, "enabled" | "shareUrl">,
  prefsError: string | null | undefined,
): CloudLinkSyncItem["status"] {
  if (config.enabled && config.shareUrl) {
    return "live";
  }
  if (prefsError) {
    return "unavailable";
  }
  if (config.enabled) {
    return "pending";
  }
  return "disabled";
}

function summarize(items: CloudLinkSyncItem[]): CloudLinkSyncReport["summary"] {
  let live = 0;
  let pending = 0;
  let disabled = 0;
  let unavailable = 0;
  for (const item of items) {
    if (item.status === "live") live += 1;
    else if (item.status === "pending") pending += 1;
    else if (item.status === "disabled") disabled += 1;
    else unavailable += 1;
  }
  return { live, pending, disabled, unavailable, total: items.length };
}

export async function buildCloudLinkSyncReport(): Promise<CloudLinkSyncReport> {
  const globalAutoPublishEnabled = isCloudAutoPublishGloballyEnabled();
  const appsHost =
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ??
    "https://apps.papr.ai";
  const paprDir = getPaprRoot();
  const titles = loadAppTitles(paprDir);

  if (titles.size === 0) {
    return {
      enabled: true,
      globalAutoPublishEnabled,
      appsHost,
      error: null,
      items: [],
      summary: { live: 0, pending: 0, disabled: 0, unavailable: 0, total: 0 },
    };
  }

  const publishService = getCloudAppPublishService();
  let reportError: string | null = null;

  const entries = [...titles.entries()];
  const configs = await Promise.all(
    entries.map(async ([appId]) => {
      try {
        return await publishService.getPublishConfig(appId);
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes("404") || message.includes("Not Found")) {
          return memoryPublishResponseToConfig(appId, null);
        }
        reportError ??= message.slice(0, 160);
        return memoryPublishResponseToConfig(appId, null);
      }
    }),
  );

  const items: CloudLinkSyncItem[] = entries.map(([appId, label], index) => {
    const prefs = getAppPublishPrefs(appId, paprDir);
    const sharing = resolveSharingSettings(prefs);
    const config = configs[index] ?? memoryPublishResponseToConfig(appId, null);
    const token = config.shareToken ?? prefs.shareToken ?? null;
    const externalEnabled = sharingSettingsRequireShareToken(sharing);
    return {
      appId,
      label,
      enabled: config.enabled,
      shareUrl: config.shareUrl,
      shareLink: formatShareLink(
        config.shareUrl,
        token,
        config.accessMode,
        externalEnabled,
      ),
      shareToken: token,
      accessMode: config.accessMode,
      loginAccess: sharing.loginAccess,
      externalLink: sharing.externalLink,
      autoPublish: prefs.autoPublish !== false,
      status: resolveStatus(config, prefs.lastAutoPublishError),
      lastError: prefs.lastAutoPublishError ?? null,
    };
  });

  items.sort((a, b) => {
    const rank = (status: CloudLinkSyncItem["status"]): number => {
      if (status === "live") return 0;
      if (status === "pending") return 1;
      if (status === "disabled") return 2;
      return 3;
    };
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return a.label.localeCompare(b.label);
  });

  return {
    enabled: true,
    globalAutoPublishEnabled,
    appsHost,
    error: reportError,
    items,
    summary: summarize(items),
  };
}
