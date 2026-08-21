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
import { readDerivedFromFile } from "./cloudSync/jsonFileCache.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";

export type CloudUploadModePref = "auto" | "manual" | "inherit";
export type CloudEnabledPref = true | false | "inherit";

function readGlobalAutoUploadDisabled(settingsPath: string): boolean {
  return readDerivedFromFile(
    settingsPath,
    "cloudAutoUploadDisabled",
    (raw) => {
      const data = JSON.parse(raw) as {
        preferences?: { cloudAutoUploadEnabled?: boolean };
      };
      return data?.preferences?.cloudAutoUploadEnabled === false;
    },
    true,
  );
}

function cloudSettingsPathForRoot(paprDir?: string): string {
  if (paprDir) {
    return path.join(paprDir, "data", "settings.json");
  }
  return defaultCloudSettingsPath();
}

/** Whether automatic git/Turso push is enabled globally (default OFF). */
export function isCloudAutoUploadGloballyEnabled(
  settingsPath: string = defaultCloudSettingsPath(),
): boolean {
  if (process.env.CLOUD_AUTO_UPLOAD_ENABLED === "false") {
    return false;
  }
  return !readGlobalAutoUploadDisabled(settingsPath);
}

function resolveUploadMode(
  prefs: CloudPublishAppPrefs,
  paprDir?: string,
): "auto" | "manual" {
  const mode = prefs.uploadMode ?? "inherit";
  if (mode === "manual") {
    return "manual";
  }
  if (mode === "auto") {
    return "auto";
  }
  return isCloudAutoUploadGloballyEnabled(cloudSettingsPathForRoot(paprDir))
    ? "auto"
    : "manual";
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
  return resolveUploadMode(prefs, paprDir) === "auto";
}

/**
 * Reverse jobId → owning appIds index.
 *
 * Scanning every app per job made a single git enqueue pass O(jobs × apps).
 * The index is rebuilt at most once per window so a burst of watcher events or
 * a full queue scan shares one pass. Ownership only changes when an app's
 * data-sources/metadata or the jobs index changes, so brief staleness at worst
 * defers a push to the next debounce cycle.
 */
const JOB_OWNER_INDEX_TTL_MS = 2_000;

interface JobOwnerIndex {
  builtAtMs: number;
  owners: Map<string, string[]>;
}

const jobOwnerIndexByRoot = new Map<string, JobOwnerIndex>();

function buildJobOwnerIndex(paprDir: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const appsDir = path.join(paprDir, "apps");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return owners;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const appId = entry.name;
    for (const jobId of resolveAppDependentJobIds(paprDir, appId)) {
      const existing = owners.get(jobId);
      if (existing) {
        existing.push(appId);
      } else {
        owners.set(jobId, [appId]);
      }
    }
  }
  return owners;
}

/** Apps that own a job via data-sources, metadata, or jobs index. */
export function listAppIdsOwningJob(paprDir: string, jobId: string): string[] {
  return [...listAppIdsOwningJobInternal(paprDir, jobId)];
}

function listAppIdsOwningJobInternal(paprDir: string, jobId: string): string[] {
  const cached = jobOwnerIndexByRoot.get(paprDir);
  const now = Date.now();
  if (cached && now - cached.builtAtMs < JOB_OWNER_INDEX_TTL_MS) {
    return cached.owners.get(jobId) ?? [];
  }

  const owners = buildJobOwnerIndex(paprDir);
  jobOwnerIndexByRoot.set(paprDir, { builtAtMs: now, owners });
  return owners.get(jobId) ?? [];
}

/** Force the next ownership lookup to rescan (app/job create, delete, relink). */
export function invalidateJobOwnerIndex(paprDir?: string): void {
  if (paprDir) {
    jobOwnerIndexByRoot.delete(paprDir);
    return;
  }
  jobOwnerIndexByRoot.clear();
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
    return isCloudAutoUploadGloballyEnabled(cloudSettingsPathForRoot(root));
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

  return isCloudAutoUploadGloballyEnabled(cloudSettingsPathForRoot(root));
}
