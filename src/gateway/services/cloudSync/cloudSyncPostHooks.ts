/**
 * Post Sync V3 flush hooks — Turso reschedule, web-ready check, auto-republish.
 */

export interface CloudSyncPostHooksHost {
  isStopped: () => boolean;
  isWriteContextValid: (context: string) => boolean;
  consumeFinalizedAppIds: () => string[];
  getPaprDir: () => string;
  setCloudPublishing: (appIds: string[]) => void;
  clearCloudPublishing: () => void;
  tryAutoPublishCloudLinks: (appIds: string[]) => Promise<void>;
}

export async function runPostSyncHooks(
  host: CloudSyncPostHooksHost,
  options?: { skipTursoReschedule?: boolean },
): Promise<void> {
  if (host.isStopped() || !host.isWriteContextValid("cloud sync post-hooks")) {
    console.warn(
      "[CloudSync] Skipping post-sync hooks — workspace switch or stale sync instance",
    );
    return;
  }
  const syncedAppIds = host.consumeFinalizedAppIds();

  const { getSyncCoordinator } = await import("./SyncCoordinator.js");
  const coordinator = getSyncCoordinator();
  const skipTurso =
    options?.skipTursoReschedule === true ||
    (coordinator !== null &&
      syncedAppIds.length > 0 &&
      coordinator.shouldSkipTursoRescheduleForApps(syncedAppIds));

  if (!skipTurso) {
    void import("../tursoPushScheduler.js")
      .then(({ scheduleTursoPushAllLinked }) =>
        scheduleTursoPushAllLinked("post_git"),
      )
      .catch((err: Error) => {
        console.warn(
          "[CloudSync] Turso push after git sync failed:",
          err.message.slice(0, 120),
        );
      });
  } else if (coordinator) {
    for (const appId of syncedAppIds) {
      coordinator.consumeTursoFlushedForApp(appId);
    }
    console.log(
      `[CloudSync] Skipping post-git Turso reschedule (${syncedAppIds.length} app(s) already flushed)`,
    );
  }

  const { webReady } = await import("./webReady.js");
  const paprDir = host.getPaprDir();
  const webReadyAppIds: string[] = [];
  for (const appId of syncedAppIds) {
    const ready = await webReady(appId, paprDir);
    if (ready.ready) {
      webReadyAppIds.push(appId);
    } else {
      console.warn(
        `[CloudSync] Skipping publish/notify for ${appId}: ${ready.reason ?? "not web-ready"}${ready.detail ? ` — ${ready.detail}` : ""}`,
      );
    }
  }

  host.setCloudPublishing(webReadyAppIds);
  try {
    await host.tryAutoPublishCloudLinks(webReadyAppIds);
  } finally {
    host.clearCloudPublishing();
  }

  // Revision cache-bust is handled by appRepoCommittedFanout → appRepoRevisionSubscriber
  // after writer ops commit (deduped by commitSha). Post-hooks must not double-notify.
}
