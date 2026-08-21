/**
 * Desktop heartbeat + periodic namespace git pull tick.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { buildDesktopHeartbeatBody } from "../syncV3/buildDesktopHeartbeatBody.js";
import type { CloudSyncService } from "../CloudSyncService.js";
import { readGatewaySyncBusyState } from "./syncBusyState.js";

export const PULL_INTERVAL_MS = 5 * 60_000;
export const DESKTOP_HEARTBEAT_INTERVAL_MS = 60_000;

export interface CloudSyncPeriodicHost {
  get sync(): CloudSyncService;
  isSyncing(): boolean;
  getSyncStatus(): "idle" | "syncing" | "queuing" | "error";
  getPullBackoffUntilMs(): number;
  shouldDeferGitPull: () => Promise<{ defer: boolean; reason?: string }>;
  tryAutoReconcileRemoteGit: () => Promise<unknown>;
  pull: () => Promise<void>;
  maybeRunRepoHygiene: () => Promise<void>;
  setPullTimer: (callback: () => void, intervalMs: number) => void;
  getHeartbeatTimer: () => ReturnType<typeof setTimeout> | null;
  setHeartbeatTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  handleSyncIndexReconcile: () => Promise<void>;
  handleTrackPullOnPublish: () => Promise<void>;
}

/** Poll Turso sync-index DB on heartbeat. */
export async function handleSyncIndexReconcile(): Promise<void> {
  const { syncTursoFromSyncIndex } = await import("../TursoSyncBridge.js");

  try {
    const summary = await syncTursoFromSyncIndex();
    if (summary.pulled > 0 || summary.pushed > 0) {
      console.log(
        `[CloudSync] Turso sync-index reconcile: pulled=${summary.pulled} pushed=${summary.pushed}`,
      );
    }
  } catch (err) {
    console.warn(
      "[CloudSync] Turso sync-index reconcile failed:",
      (err as Error).message.slice(0, 120),
    );
  }
}

/** Auto-pull track-mode installs when publisher revision changes on apps.papr.ai. */
export async function handleTrackPullOnPublish(): Promise<void> {
  try {
    const { getCloudAppTrackSyncService } = await import(
      "../CloudAppTrackSyncService.js"
    );
    await getCloudAppTrackSyncService().pullTrackAppsOnPublish();
  } catch (err) {
    console.warn(
      "[CloudSync] Track pull-on-publish skipped:",
      (err as Error).message.slice(0, 120),
    );
  }
}

/** SSE push for cloud job runtime patches (Phase 4b). */
export function startRuntimeDispatchSubscriber(): void {
  void import("../syncV3/runtimeDispatchSubscriber.js").then(
    ({ startRuntimeDispatchSubscriber: start }) => {
      start({
        onPatch: async (patch) => {
          const { getJobsService } = await import("../JobsService.js");
          const jobsService = getJobsService();
          const { applyPendingCloudRunPatches } = await import(
            "./applyPendingCloudRunPatches.js"
          );
          await applyPendingCloudRunPatches([patch], { jobsService });
        },
        onError: (message) => {
          console.warn("[CloudSync] Runtime dispatch stream:", message);
        },
      });
    },
  );
}

/** Tell memory server the desktop gateway is awake (cloud scheduler defers). */
export function startDesktopHeartbeat(host: CloudSyncPeriodicHost): void {
  if (host.getHeartbeatTimer()) {
    console.warn(
      "[CloudSync] Desktop heartbeat already running — skipping duplicate timer",
    );
    return;
  }

  const ping = async (): Promise<void> => {
    try {
      const syncBusy = readGatewaySyncBusyState(host.sync.getPaprDir());
      const queueDepth = syncBusy?.queueDepth ?? 0;
      const appVersion =
        process.env.PAPRWORK_APP_VERSION?.trim() || undefined;
      const res = await cloudApiFetch("/v1/cloud/runtime/heartbeat", {
        method: "POST",
        body: buildDesktopHeartbeatBody(appVersion),
        // Upload backlog can saturate the gateway — allow more time before aborting.
        timeoutMs: queueDepth > 0 ? 45_000 : 15_000,
      });
      if (!res.ok) {
        console.warn(
          "[CloudSync] Desktop heartbeat failed:",
          res.status,
          (await res.text()).slice(0, 80),
        );
        return;
      }
      // Do not parse pendingCloudRuns from heartbeat — SSE is the sole consumer.
      // Parsing would race the destructive server drain and drop patches.
      await res.text();
      if (queueDepth > 0) {
        return;
      }
      const { retryPendingMetadataUploads } = await import(
        "../syncV3/MetadataRegistryClient.js"
      );
      await retryPendingMetadataUploads();
      await host.handleSyncIndexReconcile();
      await host.handleTrackPullOnPublish();
      const { maybeRunBackgroundAutoPublishCatalogScan } = await import(
        "./backgroundAutoPublishCatalogScan.js"
      );
      void maybeRunBackgroundAutoPublishCatalogScan(host.sync.getPaprDir());
    } catch (err) {
      console.warn(
        "[CloudSync] Desktop heartbeat error:",
        (err as Error).message.slice(0, 80),
      );
    }
  };

  void ping();
  host.setHeartbeatTimer(
    setInterval(() => {
      void ping();
    }, DESKTOP_HEARTBEAT_INTERVAL_MS) as ReturnType<typeof setTimeout>,
  );

  console.log(
    `[CloudSync] Desktop heartbeat every ${DESKTOP_HEARTBEAT_INTERVAL_MS / 1000}s`,
  );

  startRuntimeDispatchSubscriber();
}

export function startPeriodicPull(host: CloudSyncPeriodicHost): void {
  host.setPullTimer(async () => {
    if (host.isSyncing() || host.getSyncStatus() === "queuing") return;
    if (Date.now() < host.getPullBackoffUntilMs()) return;
    try {
      const deferPull = await host.shouldDeferGitPull();
      if (deferPull.defer) {
        return;
      }
      await host.tryAutoReconcileRemoteGit();
      await host.pull();
    } catch (err) {
      console.warn(
        "[CloudSync] Periodic pull failed:",
        (err as Error).message.slice(0, 100),
      );
    }
    await host.maybeRunRepoHygiene();
  }, PULL_INTERVAL_MS);

  console.log(`[CloudSync] Periodic pull every ${PULL_INTERVAL_MS / 60_000} min`);
}
