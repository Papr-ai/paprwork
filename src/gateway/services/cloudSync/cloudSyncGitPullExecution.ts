/**
 * Namespace git pull execution (ff-only, read-only legacy path).
 */

import {
  filterNamespaceReconcilePaths,
  formatIncomingRemoteReviewBlockReason,
  listIncomingRemoteChangedPaths,
} from "./namespaceGitReview.js";
import {
  tryAutoReconcileRemoteGitInternal,
  refreshGitUpdatesAvailable,
  type CloudSyncGitRemoteHost,
} from "./cloudSyncGitRemoteReview.js";
import type { RunGitFn } from "./gitStageScope.js";

export interface CloudSyncPullHost extends CloudSyncGitRemoteHost {
  shouldDeferGitPull: () => Promise<{ defer: boolean; reason?: string }>;
  ensureFreshToken: () => Promise<string | null>;
  updateRemoteUrl: (cloneUrl: string) => Promise<void>;
  buildAuthedUrl: (cloneUrl: string, token: string) => string;
  getTokenCloneUrl: () => string | null;
  setSyncStatus: (status: "idle" | "syncing" | "queuing" | "error") => void;
  setLastSyncAt: (iso: string) => void;
  setLastError: (error: string | null) => void;
  getPullBackoffUntilMs: () => number;
  setPullBackoffUntilMs: (untilMs: number) => void;
  getConsecutivePullFailures: () => number;
  setConsecutivePullFailures: (count: number) => void;
  incrementConsecutivePullFailures: () => number;
  runExclusiveGitOp: <T>(fn: () => Promise<T>) => Promise<T>;
  enforceAppOwnershipAfterPull: () => Promise<void>;
  finalizePortableResourcesAfterPull: () => Promise<void>;
  reconcileJobsRegistryAfterPull: () => Promise<void>;
  getPaprDir: () => string;
  reconcileSubAgentsAfterPull: () => Promise<void>;
}

export async function recoverUnpushedBacklogIfNeeded(host: {
  countUnpushedCommits: () => Promise<number>;
  runGit: RunGitFn;
  invalidateAllSyncedItems: () => void;
  saveSyncState: () => void;
  reconcileAllGitCleanSubdirs: () => Promise<number>;
}): Promise<void> {
  const unpushed = await host.countUnpushedCommits();
  if (unpushed === 0) {
    return;
  }

  console.warn(
    `[CloudSync] ${unpushed} legacy namespace git commit(s) unpushed — Sync V3 no longer pushes namespace git; resetting to origin/main and re-flushing via writer ops`,
  );
  try {
    await host.runGit(["reset", "--mixed", "origin/main"]);
  } catch (err) {
    console.warn(
      "[CloudSync] Legacy git reset skipped:",
      (err as Error).message.slice(0, 120),
    );
  }
  host.invalidateAllSyncedItems();
  host.saveSyncState();
  await host.reconcileAllGitCleanSubdirs();
}

export async function executeNamespaceGitPull(host: CloudSyncPullHost): Promise<void> {
  const deferPull = await host.shouldDeferGitPull();
  if (deferPull.defer) {
    console.log(
      `[CloudSync] Pull skipped — ${deferPull.reason ?? "local work pending"}; push local changes first`,
    );
    return;
  }

  console.log("[CloudSync] Pulling latest...");
  host.setSyncStatus("syncing");

  const token = await host.ensureFreshToken();
  if (!token) {
    host.setSyncStatus("idle");
    return;
  }
  const cloneUrl = host.getTokenCloneUrl();
  if (cloneUrl) {
    await host.updateRemoteUrl(host.buildAuthedUrl(cloneUrl, token));
  }

  try {
    const preReconcile = await host.runExclusiveGitOp(async () =>
      tryAutoReconcileRemoteGitInternal(host),
    );
    if (preReconcile === "requires_review") {
      const rawPaths = await listIncomingRemoteChangedPaths(host.runGit);
      const paths = filterNamespaceReconcilePaths(rawPaths);
      const summary = await host.runGit([
        "log",
        "--oneline",
        "-30",
        "HEAD..origin/main",
      ]);
      console.warn(
        `[CloudSync] Pull blocked — ${formatIncomingRemoteReviewBlockReason(summary, paths)}; awaiting owner review (updates_available)`,
      );
      await refreshGitUpdatesAvailable(host);
      host.setSyncStatus("idle");
      host.setLastError(null);
      host.setConsecutivePullFailures(0);
      host.setPullBackoffUntilMs(0);
      return;
    }
    if (preReconcile === "merged") {
      console.log("[CloudSync] Pull: pre-merged cloud runtime metadata");
    }

    await captureSubAgentsBeforeGitPull(host.getPaprDir());
    const output = await host.runGit([
      "pull",
      "--rebase=false",
      "--ff-only",
      "origin",
      "main",
    ]);
    const pullSummary = output.split("\n")[0] ?? "";
    console.log("[CloudSync] Pull:", pullSummary);
    host.setSyncStatus("idle");
    host.setLastSyncAt(new Date().toISOString());
    host.setLastError(null);
    host.setConsecutivePullFailures(0);
    host.setPullBackoffUntilMs(0);

    const pulledChanges = !pullSummary.includes("Already up to date");

    if (pulledChanges) {
      await host.enforceAppOwnershipAfterPull();
      await host.finalizePortableResourcesAfterPull();
      await host.reconcileJobsRegistryAfterPull();
      await host.reconcileSubAgentsAfterPull();
    }

    await host.pullTursoLinkedSourcesAfterGitPull();
  } catch (err) {
    const msg = (err as Error).message;
    const normalized = msg.toLowerCase();
    if (msg.includes("Already up to date")) {
      host.setSyncStatus("idle");
      host.setConsecutivePullFailures(0);
      host.setPullBackoffUntilMs(0);
      await host.pullTursoLinkedSourcesAfterGitPull();
      return;
    }

    const diverged =
      normalized.includes("conflict") ||
      normalized.includes("diverging branches") ||
      normalized.includes("divergent branches") ||
      normalized.includes("not possible to fast-forward") ||
      normalized.includes("cannot fast-forward");
    if (diverged) {
      const reconciled = await host.runExclusiveGitOp(async () =>
        tryAutoReconcileRemoteGitInternal(host),
      );
      if (reconciled === "merged") {
        console.log("[CloudSync] Pull: auto-merged cloud runtime metadata");
        host.setSyncStatus("idle");
        host.setLastSyncAt(new Date().toISOString());
        host.setLastError(null);
        host.setConsecutivePullFailures(0);
        host.setPullBackoffUntilMs(0);
        await host.enforceAppOwnershipAfterPull();
        await host.reconcileJobsRegistryAfterPull();
        await host.reconcileSubAgentsAfterPull();
        await host.pullTursoLinkedSourcesAfterGitPull();
        return;
      }

      console.warn(
        "[CloudSync] Pull blocked — remote has code changes; awaiting owner review (updates_available)",
      );
      try {
        await refreshGitUpdatesAvailable(host);
        host.setSyncStatus("idle");
        host.setLastError(null);
        host.setConsecutivePullFailures(0);
        host.setPullBackoffUntilMs(0);
        return;
      } catch (re) {
        console.error(
          "[CloudSync] Failed to detect remote updates:",
          (re as Error).message.slice(0, 200),
        );
      }
    }

    const failures = host.incrementConsecutivePullFailures();
    const backoffMs = Math.min(10 * 60_000, 30_000 * 2 ** (failures - 1));
    host.setPullBackoffUntilMs(Date.now() + backoffMs);
    console.error(
      `[CloudSync] Pull failed; retrying in ${Math.ceil(backoffMs / 1_000)}s:`,
      msg.slice(0, 200),
    );
    host.setSyncStatus("error");
    host.setLastError(msg.slice(0, 200));
  }
}

export async function enforceAppOwnershipAfterPull(): Promise<void> {
  try {
    const { getAppService } = await import("../AppService.js");
    await getAppService().enforceAppOwnershipIndex();
  } catch (ownershipErr) {
    console.warn(
      "[CloudSync] Post-pull app ownership enforcement failed:",
      (ownershipErr as Error).message.slice(0, 120),
    );
  }
}

export async function finalizePortableResourcesAfterPull(): Promise<void> {
  try {
    const { finalizePortableCloudAppResources } = await import(
      "../cloudAppLinkedResourcesInstall.js"
    );
    await finalizePortableCloudAppResources();
  } catch (repairErr) {
    console.warn(
      "[CloudSync] Portable resource repair after pull failed:",
      (repairErr as Error).message.slice(0, 120),
    );
  }
}

export async function reconcileSubAgentsAfterPull(paprDir: string): Promise<void> {
  try {
    const {
      consumePrePullCustomSubAgentSnapshot,
      reconcileSubAgentProfilesOnDisk,
      formatOrphanedSubAgentWarning,
    } = await import("../subagents/subAgentIntegrity.js");
    const preserved = consumePrePullCustomSubAgentSnapshot();
    const result = await reconcileSubAgentProfilesOnDisk(paprDir, preserved);
    if (preserved.length > 0 && result.mergedCustomProfiles > 0) {
      console.log(
        `[CloudSync] Merged ${preserved.length} custom sub-agent profile(s) after git pull`,
      );
    }
    if (result.recoveredFromSidecar.length > 0) {
      console.warn(
        `[CloudSync] Recovered sub-agent profile(s) from agent-chat sidecar: ${result.recoveredFromSidecar.join(", ")}`,
      );
    }
    const warning = formatOrphanedSubAgentWarning(result.stillOrphaned);
    if (warning) {
      console.warn(warning);
    }
    const { getSubAgentService } = await import("../SubAgentService.js");
    await getSubAgentService().reloadProfilesFromDisk();
  } catch (err) {
    console.warn(
      "[CloudSync] Post-pull sub-agent reconcile failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}

export async function captureSubAgentsBeforeGitPull(paprDir: string): Promise<void> {
  try {
    const { captureCustomSubAgentsBeforeGitPull } = await import(
      "../subagents/subAgentIntegrity.js"
    );
    captureCustomSubAgentsBeforeGitPull(paprDir);
  } catch {
    /* non-fatal */
  }
}

export async function reconcileJobsRegistryAfterPull(): Promise<void> {
  try {
    const { reconcileJobsRegistryAfterSync } = await import(
      "../jobs/jobsRegistryReconcile.js"
    );
    await reconcileJobsRegistryAfterSync();
  } catch (err) {
    console.warn(
      "[CloudSync] Post-pull jobs registry reconcile failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}
