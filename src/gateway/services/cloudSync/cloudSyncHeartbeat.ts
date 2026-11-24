/**
 * Desktop heartbeat + periodic namespace git pull tick.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { buildDesktopHeartbeatBody } from "../syncV3/buildDesktopHeartbeatBody.js";
import type { CloudSyncService } from "../CloudSyncService.js";
import { readGatewaySyncBusyState } from "./syncBusyState.js";
import { notifyCloudSyncItemsStale } from "./cloudSyncBroadcast.js";
import { getPaprUserId } from "../../utils/paprUserId.js";
import type { DbChangedEvent } from "../syncV3/runtimeDispatchSubscriber.js";
import type { CloudTursoDbChange } from "../tursoSyncSession.js";

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

const DB_CHANGED_DEBOUNCE_MS = 400;
/**
 * The event can beat the change to the replica we pull from: a pull right after it may find
 * nothing new yet. Ask again after these waits, then leave it to the heartbeat. Replaces the
 * fixed 1s sleep memory#474 put in front of every notification.
 */
export const DB_CHANGED_RETRY_MS = [250, 1000, 3000];
let pendingDbChanges: CloudTursoDbChange[] = [];
let dbChangedTimer: ReturnType<typeof setTimeout> | null = null;
let dbChangedPulling = false;

/**
 * Fast path: memory pushed "database X changed" over the dispatch stream. Pull just
 * that database now instead of waiting for the next heartbeat. A burst becomes one
 * pull; anything not matched to a linked database here is caught by the heartbeat.
 */
function queueDbChangedPull(event: DbChangedEvent): void {
  if (!event.dbId && !event.jobId) {
    return;
  }
  pendingDbChanges.push({
    ...(event.dbId ? { dbId: event.dbId } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    ...(event.tables ? { tables: event.tables } : {}),
  });
  if (dbChangedTimer) {
    return;
  }
  dbChangedTimer = setTimeout(() => {
    dbChangedTimer = null;
    void flushDbChangedPulls();
  }, DB_CHANGED_DEBOUNCE_MS);
}

/** Pull until something lands or the waits run out. Exported for tests. */
export async function pullDbChangesWithRetry(
  batch: CloudTursoDbChange[],
  pull: (changes: CloudTursoDbChange[]) => Promise<{ pulled: number; pushed: number; failed: number }>,
  waits: readonly number[] = DB_CHANGED_RETRY_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ pulled: number; pushed: number; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    const s = await pull(batch);
    // Landed, failed for a real reason, or out of waits: stop. Only an empty pull is retried.
    if (s.pulled > 0 || s.pushed > 0 || s.failed > 0 || attempt >= waits.length) {
      return { pulled: s.pulled, pushed: s.pushed, attempts: attempt + 1 };
    }
    await sleep(waits[attempt]);
  }
}

async function flushDbChangedPulls(): Promise<void> {
  if (dbChangedPulling || pendingDbChanges.length === 0) {
    return;
  }
  dbChangedPulling = true;
  const batch = pendingDbChanges;
  pendingDbChanges = [];
  try {
    const { getTursoSyncBridge } = await import("../TursoSyncBridge.js");
    const bridge = getTursoSyncBridge();
    if (bridge?.enabled) {
      const started = Date.now();
      const r = await pullDbChangesWithRetry(batch, (c) => bridge.reconcileFromCloudDbChanges(c));
      console.log(
        `[CloudSync] db-changed push pull: pulled=${r.pulled} pushed=${r.pushed} ` +
          `attempts=${r.attempts} in ${Date.now() - started}ms`,
      );
    }
  } catch (err) {
    console.warn("[CloudSync] db-changed push pull failed:", (err as Error).message.slice(0, 120));
  } finally {
    dbChangedPulling = false;
    if (pendingDbChanges.length > 0) {
      void flushDbChangedPulls();
    }
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
        onDbChanged: queueDbChangedPull,
        onError: (message) => {
          console.warn("[CloudSync] Runtime dispatch stream:", message);
        },
      });
    },
  );
}

/** Tell memory server the desktop gateway is awake (cloud scheduler defers). */
async function pollProposalEventsForCurrentUser(paprDir: string): Promise<void> {
  const userId = getPaprUserId();
  if (!userId) return;
  const { pollProposalEvents } = await import("./proposalEvents.js");
  // Your notices from the server list: boot pull once, then a catch-up pull every heartbeat (notices.changed pulls sooner).
  await import("../notifications/noticeCloudSync.js").then(async (m) => { await m.startNoticeCloudSync(); m.scheduleNoticePull("heartbeat", 0); }).catch(() => undefined);
  await pollProposalEvents(paprDir, userId);
  await import("../collab/mentions.js").then((m) => m.remindPromises()).catch(() => undefined);
}

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
      // Proposal accepted/declined/needs-update from another machine: refresh
      // share bars + inbox and raise an OS notice within one heartbeat.
      void pollProposalEventsForCurrentUser(host.sync.getPaprDir());
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
        // The git pull waits for local uploads, but "has someone published
        // elsewhere?" is a read-only question — still ask it, or collaborators
        // with any pending upload never see Update from publisher / Get updates.
        notifyCloudSyncItemsStale();
        return;
      }
      await host.tryAutoReconcileRemoteGit();
      await host.pull();
      // Teammate schema changes held for review: settle once the publisher has
      // approved (cloud ledger has them) or rejected the proposal.
      await import("../tursoReplica/settleProposalHolds.js")
        .then(({ settleProposalHolds }) => settleProposalHolds())
        .catch(() => []);
      // The 5-min tick is the only round trip we make, so anything that needs
      // asking the web rides along with it — including incoming contributions,
      // which the renderer refetches when this lands.
      notifyCloudSyncItemsStale();
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
