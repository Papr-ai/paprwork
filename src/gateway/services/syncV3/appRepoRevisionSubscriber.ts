/**
 * Subscribe to writer commit events and invalidate cloud-app-host caches (Phase 2.4).
 */

import type { AppRepoCommittedEvent } from "./appRepoCommittedFanout.js";
import {
  readAppRepoCommitCursors,
  subscribeAppRepoCommitted,
  writeAppRepoCommitCursor,
} from "./appRepoCommittedFanout.js";
import { ingestAppRepoCommittedEvent } from "./appRepoCommittedInbound.js";
import { pullDesktopAppOnRemoteCommit } from "./pullAppCodeFromRepo.js";
import { parsePublishedAppRoute } from "../cloudSync/notifyCloudAppRevision.js";

let unsubscribe: (() => void) | null = null;

async function handleCommittedEvent(event: AppRepoCommittedEvent): Promise<void> {
  const cursors = await readAppRepoCommitCursors();
  const prior = cursors[event.appId]?.lastCommitSha;
  if (prior === event.commitSha) {
    return;
  }

  await pullDesktopAppOnRemoteCommit({
    appId: event.appId,
    commitSha: event.commitSha,
  });

  await writeAppRepoCommitCursor(event.appId, event.commitSha);

  const { getCloudAppPublishService } = await import("../CloudAppPublishService.js");
  try {
    const status = await getCloudAppPublishService().getCloudPublishStatus(event.appId);
    if (!status.published || !status.shareUrl) {
      return;
    }
    const route = parsePublishedAppRoute(status.shareUrl);
    if (!route) {
      return;
    }

    const { notifyCloudAppRevisionUpdated } = await import(
      "../cloudSync/notifyCloudAppRevision.js"
    );
    await notifyCloudAppRevisionUpdated(route);
  } catch (err) {
    console.warn(
      `[AppRepoRevisionSubscriber] Skipped revision notify for ${event.appId}:`,
      (err as Error).message.slice(0, 80),
    );
  }
}

/** Start in-process subscriber (idempotent). */
export function startAppRepoRevisionSubscriber(): void {
  if (unsubscribe) {
    return;
  }
  unsubscribe = subscribeAppRepoCommitted((event) => {
    void handleCommittedEvent(event).catch((err) => {
      console.warn(
        `[AppRepoRevisionSubscriber] Failed for ${event.appId}:`,
        (err as Error).message.slice(0, 120),
      );
    });
  });
}

export function stopAppRepoRevisionSubscriberForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
}

/** HTTP / Pub/Sub push entry — fanout triggers in-process subscribers. */
export async function receiveAppRepoCommittedEvent(
  event: AppRepoCommittedEvent,
): Promise<void> {
  await ingestAppRepoCommittedEvent(event);
}
