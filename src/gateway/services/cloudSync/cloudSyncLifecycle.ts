/**
 * Cloud sync startup — token fetch, namespace git clone/pull, initial V3 queue.
 */

import { waitForPaprApiKey } from "../../utils/cloudApiClient.js";
import {
  buildAuthedUrl,
  getForeignGitRoot,
  hasWorkspaceGitAtRoot,
  normalizeRepoIdentity,
} from "./cloudSyncToken.js";
import { getChangedInstantPaths } from "./cloudSyncWorkspaceWatch.js";
import type { GitRunner } from "./gitRunner.js";
import type { RunGitFn } from "./gitStageScope.js";
import type { SyncStateManager } from "./syncState.js";

export interface CloudSyncLifecycleHost {
  getPaprDir(): string;
  getGitRunner(): GitRunner;
  runGit: RunGitFn;
  setSyncStatus: (status: "idle" | "syncing" | "queuing" | "error") => void;
  setLastError: (error: string | null) => void;
  setLastSyncAt: (iso: string) => void;
  callReposInit: () => Promise<boolean>;
  fetchRepoToken: () => Promise<{
    repos: Array<{ scope: string; repoUrl: string; cloneUrl: string }>;
    token: string;
    expiresAt: string;
  } | null>;
  applyUserRepoToken: (
    userRepo: { repoUrl: string; cloneUrl: string },
    token: string,
    expiresAt: string,
  ) => void;
  initialClone: (cloneUrl: string) => Promise<void>;
  updateRemoteUrl: (cloneUrl: string) => Promise<void>;
  getOriginRepoIdentity: () => Promise<string | null>;
  onRepoIdentityChanged: () => void;
  getRepoIdentityChanged: () => boolean;
  shouldDeferGitPull: () => Promise<{ defer: boolean; reason?: string }>;
  pull: () => Promise<void>;
  getStateManager: () => SyncStateManager;
  startWorkspaceWatcher: () => void;
  startPeriodicPull: () => void;
  startDesktopHeartbeat: () => void;
  recoverUnpushedBacklogIfNeeded: () => Promise<void>;
  enqueueSubDirs: () => Promise<void>;
  enqueueAutoUploadApps: () => Promise<void>;
  getSyncQueueLength: () => number;
  finishQueueProcessing: () => Promise<void>;
  startQueueProcessor: () => void;
}

export async function runBackgroundInit(host: CloudSyncLifecycleHost): Promise<void> {
  const paprKey = await waitForPaprApiKey();
  if (!paprKey) {
    console.warn("[CloudSync] No PAPR_API_KEY — login with Papr first");
    host.setSyncStatus("error");
    host.setLastError("PAPR_API_KEY not configured");
    return;
  }

  await host.callReposInit();

  const tokenResp = await host.fetchRepoToken();
  if (!tokenResp) {
    console.warn("[CloudSync] No git token from memory server");
    host.setSyncStatus("error");
    host.setLastError("Could not fetch cloud repo token");
    return;
  }

  const userRepo = tokenResp.repos.find((r) => r.scope === "user");
  if (!userRepo) {
    console.warn("[CloudSync] No user repo in token response");
    host.setSyncStatus("error");
    host.setLastError("No user repo in token response");
    return;
  }

  host.applyUserRepoToken(userRepo, tokenResp.token, tokenResp.expiresAt);
  const targetIdentity = normalizeRepoIdentity(userRepo.cloneUrl);
  console.log(`[CloudSync] Papr cloud repo: ${targetIdentity}`);

  const cloneUrl = buildAuthedUrl(userRepo.cloneUrl, tokenResp.token);
  const paprDir = host.getPaprDir();

  const foreignGitRoot = await getForeignGitRoot(
    paprDir,
    host.getGitRunner(),
    host.runGit,
  );
  if (foreignGitRoot) {
    console.warn(
      `[CloudSync] Ignoring parent git at ${foreignGitRoot} — workspace ${paprDir} needs its own cloud repo`,
    );
  }

  if (!hasWorkspaceGitAtRoot(paprDir)) {
    await host.initialClone(cloneUrl);
  } else {
    const previousIdentity = await host.getOriginRepoIdentity();
    if (previousIdentity && previousIdentity !== targetIdentity) {
      host.onRepoIdentityChanged();
      console.log(
        `[CloudSync] Local origin differs (${previousIdentity} → ${targetIdentity}) — will publish local history`,
      );
    }
    await host.updateRemoteUrl(cloneUrl);
    if (!host.getRepoIdentityChanged()) {
      const deferPull = await host.shouldDeferGitPull();
      if (deferPull.defer) {
        console.log(
          `[CloudSync] Startup pull deferred — ${deferPull.reason ?? "local work pending"}`,
        );
      } else {
        await host.pull();
      }
    }
  }

  host.getStateManager().load();
  host.startWorkspaceWatcher();
  host.startPeriodicPull();
  host.startDesktopHeartbeat();

  host.setSyncStatus("idle");
  console.log("[CloudSync] Ready — watching for changes (initial sync continues in background)");

  void runInitialSyncPipeline(host).catch((err: Error) => {
    console.warn("[CloudSync] Initial sync failed:", err.message.slice(0, 200));
    host.setLastError(err.message.slice(0, 200));
  });
}

export async function runInitialSyncPipeline(host: CloudSyncLifecycleHost): Promise<void> {
  await host.recoverUnpushedBacklogIfNeeded();

  const instantPaths = getChangedInstantPaths(
    host.getPaprDir(),
    host.getStateManager(),
  );
  for (const relativePath of instantPaths) {
    host.getStateManager().markSynced(relativePath);
  }
  if (instantPaths.length > 0) {
    host.getStateManager().save();
    console.log(
      `[CloudSync] Tracked ${instantPaths.length} workspace/data change(s) locally (namespace git push disabled — Sync V3)`,
    );
  }

  await host.enqueueSubDirs();
  await host.enqueueAutoUploadApps();
  if (host.getSyncQueueLength() === 0) {
    await host.finishQueueProcessing();
  } else {
    host.startQueueProcessor();
  }
  host.setLastSyncAt(new Date().toISOString());

  void runWorkspaceLogGenesisCutover().catch((err: Error) => {
    console.warn(
      "[CloudSync] Workspace log genesis cutover:",
      err.message.slice(0, 120),
    );
  });
}

/** Phase 3 — idempotent genesis for every linked Turso replica. */
async function runWorkspaceLogGenesisCutover(): Promise<void> {
  const { runWorkspaceLogGenesisCutoverForAllLinkedSources } = await import(
    "../syncV3/workspaceLogGenesisCutover.js"
  );
  const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();
  if (summary.completed > 0) {
    console.log(
      `[CloudSync] Workspace log genesis: completed=${summary.completed} skipped=${summary.skipped} failed=${summary.failed}`,
    );
  }
}
