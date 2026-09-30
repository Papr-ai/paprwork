/**
 * Sync V3 push — writer ops + workspace log only (no namespace git push).
 */

import * as fs from "fs";
import * as path from "path";
import type { CloudSyncService, PushGitScopedResult } from "../CloudSyncService.js";
import {
  listAppIdsOwningJob,
  shouldAutoUploadApp,
  shouldAutoUploadJobFolder,
} from "../cloudUploadMode.js";
import { flushAutoUploadAppFolderIfNeeded } from "./flushQueuedAppFolder.js";

export interface PushV3ScopedOptions {
  appId?: string;
  jobId?: string;
}

async function flushAppViaCoordinator(
  sync: CloudSyncService,
  appId: string,
  trigger: "manual" | "auto",
): Promise<void> {
  const { getSyncCoordinator } = await import("./SyncCoordinator.js");
  const coordinator = getSyncCoordinator();
  if (!coordinator) {
    const { flushAppNow } = await import("./flushAppNow.js");
    await flushAppNow(sync, appId, { skipTursoReschedule: trigger === "manual" });
    return;
  }
  await coordinator.flushNow(appId, { trigger });
}

async function pushAppScope(
  sync: CloudSyncService,
  appId: string,
  trigger: "manual" | "auto",
): Promise<PushGitScopedResult> {
  const paprDir = sync.getPaprDir();
  if (!shouldAutoUploadApp(appId, paprDir)) {
    return {
      pushedPaths: [],
      skippedPaths: [path.join("apps", appId)],
      scope: "app",
      appId,
    };
  }
  await flushAppViaCoordinator(sync, appId, trigger);
  sync.markRelativePathSynced(path.join("apps", appId));
  return {
    pushedPaths: [path.join("apps", appId)],
    skippedPaths: [],
    scope: "app",
    appId,
  };
}

async function pushJobScope(
  sync: CloudSyncService,
  jobId: string,
  trigger: "manual" | "auto",
): Promise<PushGitScopedResult> {
  const paprDir = sync.getPaprDir();
  const jobPath = path.join("Jobs", jobId);
  const owners = listAppIdsOwningJob(paprDir, jobId);
  if (owners.length === 0) {
    if (!shouldAutoUploadJobFolder(jobId, paprDir)) {
      return {
        pushedPaths: [],
        skippedPaths: [jobPath],
        scope: "job",
        jobId,
      };
    }
    console.warn(
      `[CloudSync] Job ${jobId} has no owning app — namespace git push disabled; link job to an app for Sync V3 upload`,
    );
    sync.markRelativePathSynced(jobPath);
    return { pushedPaths: [jobPath], skippedPaths: [], scope: "job", jobId };
  }

  const pushedPaths: string[] = [];
  for (const appId of owners) {
    const result = await pushAppScope(sync, appId, trigger);
    pushedPaths.push(...result.pushedPaths);
  }
  sync.markRelativePathSynced(jobPath);
  return { pushedPaths: [...new Set([...pushedPaths, jobPath])], skippedPaths: [], scope: "job", jobId };
}

/** Push changed auto-upload app folders from the sync queue (v3 flush, no git). */
export async function pushQueuedAppFoldersV3(sync: CloudSyncService): Promise<void> {
  const queue = sync.getSyncQueueSnapshot();
  for (const item of queue) {
    const handled = await flushAutoUploadAppFolderIfNeeded(sync, item.relativePath, "auto");
    if (handled) {
      sync.markRelativePathSynced(item.relativePath);
    }
  }
}

async function pushChangedAutoUploadApps(
  sync: CloudSyncService,
  trigger: "manual" | "auto",
): Promise<PushGitScopedResult> {
  const paprDir = sync.getPaprDir();
  const appsDir = path.join(paprDir, "apps");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return { pushedPaths: [], skippedPaths: [], scope: "workspace" };
  }

  const pushedPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const appId = entry.name;
    const relativePath = path.join("apps", appId);
    if (!shouldAutoUploadApp(appId, paprDir)) {
      skippedPaths.push(relativePath);
      continue;
    }
    if (!sync.hasRelativePathChanged(relativePath)) {
      skippedPaths.push(relativePath);
      continue;
    }
    const result = await pushAppScope(sync, appId, trigger);
    pushedPaths.push(...result.pushedPaths);
    skippedPaths.push(...result.skippedPaths);
  }
  return { pushedPaths, skippedPaths, scope: "workspace" };
}

/** Scoped or full workspace push via Sync V3 (writer + workspace log). */
export async function pushWorkspaceV3Now(
  sync: CloudSyncService,
  options: PushV3ScopedOptions = {},
  trigger: "manual" | "auto" = "manual",
): Promise<PushGitScopedResult> {
  if (options.appId) {
    return pushAppScope(sync, options.appId, trigger);
  }
  if (options.jobId) {
    return pushJobScope(sync, options.jobId, trigger);
  }

  const pushedPaths: string[] = [];
  const skippedPaths: string[] = [];

  const instantPaths = sync.getChangedInstantPathsForV3();
  for (const relativePath of instantPaths) {
    sync.markRelativePathSynced(relativePath);
    pushedPaths.push(relativePath);
  }

  await pushQueuedAppFoldersV3(sync);

  const appsResult = await pushChangedAutoUploadApps(sync, trigger);

  pushedPaths.push(...appsResult.pushedPaths);
  skippedPaths.push(...appsResult.skippedPaths);

  return {
    pushedPaths: [...new Set(pushedPaths)],
    skippedPaths: [...new Set(skippedPaths)],
    scope: "workspace",
  };
}
