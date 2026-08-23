/**
 * Writer ops push for a paprDir — usable from desktop CloudSync and cloud sandbox.
 */

import type { CloudSyncService } from "../CloudSyncService.js";
import {
  collectAppOpFiles,
  refreshOpParentHashes,
  resolveWriterSyncedLocalPaths,
} from "./collectAppOpFiles.js";
import { postAppOps } from "./AppOpsClient.js";
import {
  appendOutboxEntry,
  listPendingOutboxEntries,
  markOutboxAcked,
  markOutboxDeadLetter,
  markOutboxFailed,
  markOutboxInflight,
} from "./SyncOutbox.js";
import {
  isPermanentWriterClientError,
  writerErrorMessage,
} from "./writerOutboxErrors.js";
import { ensureAppRepoRecord, getAppRepoRecord } from "./AppRepoClient.js";
import type { PushAppViaWriterResult } from "./pushAppViaWriterOps.js";

const MAX_OUTBOX_ATTEMPTS = 5;

export interface PushAppWriterOpsForPaprDirOptions {
  paprDir: string;
  appId: string;
  message?: string;
  author?: string;
  /** Called with workspace-relative paths after a successful push. */
  onSynced?: (relativePaths: readonly string[]) => void | Promise<void>;
  /** When true, skip prepareAppForCloudGitSync (caller already prepared). */
  skipPrepare?: boolean;
}

async function handleOutboxPushFailure(
  entryId: string,
  err: unknown,
  attempts: number,
): Promise<never> {
  const message = writerErrorMessage(err);
  if (isPermanentWriterClientError(err) || attempts >= MAX_OUTBOX_ATTEMPTS) {
    await markOutboxDeadLetter(entryId, message);
  } else {
    await markOutboxFailed(entryId, message);
  }
  throw err;
}

async function markSyncedPaths(
  paprDir: string,
  appId: string,
  onSynced?: PushAppWriterOpsForPaprDirOptions["onSynced"],
): Promise<void> {
  const relativePaths = await resolveWriterSyncedLocalPaths(paprDir, appId);
  if (onSynced) {
    await onSynced(relativePaths);
  }
}

export async function pushAppWriterOpsForPaprDir(
  options: PushAppWriterOpsForPaprDirOptions,
): Promise<PushAppViaWriterResult> {
  const {
    paprDir,
    appId,
    message,
    author = "paprwork-desktop",
    onSynced,
  } = options;

  await ensureAppRepoRecord(appId);

  let outboxReplayed = 0;
  const pending = await listPendingOutboxEntries(appId);
  for (const entry of pending) {
    if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) {
      await markOutboxDeadLetter(
        entry.id,
        entry.lastError ?? "Exceeded max outbox retry attempts",
      );
      continue;
    }
    await markOutboxInflight(entry.id);
    const files = await refreshOpParentHashes(appId, entry.files);
    if (files.length === 0) {
      await markOutboxAcked(entry.id, entry.commitSha ?? "noop");
      continue;
    }
    try {
      const ack = await postAppOps(appId, {
        files,
        author: entry.author,
        message: entry.message,
        idempotencyKey: entry.idempotencyKey,
      });
      await markOutboxAcked(entry.id, ack.commitSha);
      outboxReplayed += 1;
    } catch (err) {
      return handleOutboxPushFailure(entry.id, err, entry.attempts + 1);
    }
  }

  if (!options.skipPrepare) {
    const { prepareAppForCloudGitSync } =
      await import("../cloudSync/prepareAppsForCloud.js");
    await prepareAppForCloudGitSync(paprDir, appId);
  }

  const collected = await collectAppOpFiles(paprDir, appId);
  if (collected.files.length === 0) {
    await markSyncedPaths(paprDir, appId, onSynced);
    return {
      appId,
      filesSent: 0,
      skippedUnchanged: collected.skippedUnchanged,
      outboxReplayed,
      deferred: collected.deferred,
    };
  }

  const commitMessage =
    message ?? `app sync: ${appId} (${collected.files.length} files)`;

  const outboxEntry = await appendOutboxEntry({
    appId,
    files: collected.files,
    author,
    message: commitMessage,
  });

  await markOutboxInflight(outboxEntry.id);
  try {
    const ack = await postAppOps(appId, {
      files: collected.files,
      author: outboxEntry.author,
      message: outboxEntry.message,
      idempotencyKey: outboxEntry.idempotencyKey,
    });
    await markOutboxAcked(outboxEntry.id, ack.commitSha);
    await markSyncedPaths(paprDir, appId, onSynced);

    const record = await getAppRepoRecord(appId);
    if (record && ack.commitSha) {
      const { fanoutAppRepoCommitted } =
        await import("./appRepoCommittedFanout.js");
      await fanoutAppRepoCommitted({
        appId,
        commitSha: ack.commitSha,
        githubOrg: record.githubOrg,
        repoName: record.repoName,
        namespaceId: record.namespaceId,
        committedAt: new Date().toISOString(),
      });
    }

    return {
      appId,
      commitSha: ack.commitSha,
      filesSent: collected.files.length,
      skippedUnchanged: collected.skippedUnchanged,
      outboxReplayed,
      deferred: collected.deferred,
    };
  } catch (err) {
    return handleOutboxPushFailure(outboxEntry.id, err, 1);
  }
}

/** Desktop CloudSync wrapper — marks synced paths on the sync service. */
export async function pushAppViaWriterOpsFromSync(
  sync: CloudSyncService,
  appId: string,
  message?: string,
): Promise<PushAppViaWriterResult> {
  const paprDir = sync.getPaprDir();
  return pushAppWriterOpsForPaprDir({
    paprDir,
    appId,
    message,
    author: "paprwork-desktop",
    onSynced: (relativePaths) => {
      for (const relativePath of relativePaths) {
        sync.markRelativePathSynced(relativePath);
      }
    },
  });
}
