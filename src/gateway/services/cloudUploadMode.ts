/**
 * Global + per-app upload mode for cloud git/Turso auto-push (SYNC_CONTRACT §2).
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { defaultCloudSettingsPath } from "./cloudAutoPublishSettings.js";
import {
  getAppPublishPrefs,
  type CloudPublishAppPrefs,
} from "./cloudPublishPrefs.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";

export type CloudUploadModePref = "auto" | "manual" | "inherit";
export type CloudEnabledPref = true | false | "inherit";

function readGlobalAutoUploadDisabled(settingsPath: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      preferences?: { cloudAutoUploadEnabled?: boolean };
    };
    return data?.preferences?.cloudAutoUploadEnabled === false;
  } catch {
    return false;
  }
}

/** Whether automatic git/Turso push is enabled globally (default ON). */
export function isCloudAutoUploadGloballyEnabled(
  settingsPath: string = defaultCloudSettingsPath(),
): boolean {
  if (process.env.CLOUD_AUTO_UPLOAD_ENABLED === "false") {
    return false;
  }
  return !readGlobalAutoUploadDisabled(settingsPath);
}

function resolveUploadMode(prefs: CloudPublishAppPrefs): "auto" | "manual" {
  const mode = prefs.uploadMode ?? "inherit";
  if (mode === "manual") {
    return "manual";
  }
  if (mode === "auto") {
    return "auto";
  }
  return isCloudAutoUploadGloballyEnabled() ? "auto" : "manual";
}

function isCloudEnabledForApp(prefs: CloudPublishAppPrefs): boolean {
  const enabled = prefs.cloudEnabled ?? "inherit";
  if (enabled === false) {
    return false;
  }
  return true;
}

export function shouldAutoUploadApp(appId: string, paprDir?: string): boolean {
  const prefs = getAppPublishPrefs(appId, paprDir);
  if (!isCloudEnabledForApp(prefs)) {
    return false;
  }
  return resolveUploadMode(prefs) === "auto";
}

function listAppIdsOwningJob(paprDir: string, jobId: string): string[] {
  const appsDir = path.join(paprDir, "apps");
  if (!fs.existsSync(appsDir)) {
    return [];
  }
  const owners: string[] = [];
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const appId = entry.name;
    if (resolveAppDependentJobIds(paprDir, appId).includes(jobId)) {
      owners.push(appId);
    }
  }
  return owners;
}

/** Gate auto Turso push for a linked source's owning app. */
export function shouldAutoUploadTursoForApp(
  appId: string,
  paprDir?: string,
): boolean {
  return shouldAutoUploadApp(appId, paprDir);
}

/**
 * Gate auto push for a job folder. Skips when every owning app is manual-only.
 * Orphan jobs (no app owner) follow the global auto-upload preference.
 */
export function shouldAutoUploadJobFolder(
  jobId: string,
  paprDir?: string,
): boolean {
  const root = paprDir ?? getPaprRoot();
  const owners = listAppIdsOwningJob(root, jobId);
  if (owners.length === 0) {
    return isCloudAutoUploadGloballyEnabled();
  }
  return owners.every((appId) => shouldAutoUploadApp(appId, root));
}

/**
 * Gate auto git push for a Papr-relative path (apps/{id}, Jobs/{id}, workspace, data).
 */
export function shouldAutoUploadRelativePath(
  relativePath: string,
  paprDir?: string,
): boolean {
  const root = paprDir ?? getPaprRoot();
  const normalized = relativePath.replace(/\\/g, "/");

  if (normalized.startsWith("apps/")) {
    const appId = path.basename(normalized);
    return shouldAutoUploadApp(appId, root);
  }

  if (normalized.startsWith("Jobs/") || normalized.startsWith("jobs/")) {
    const jobId = path.basename(normalized);
    return shouldAutoUploadJobFolder(jobId, root);
  }

  return isCloudAutoUploadGloballyEnabled();
}
