/**
 * Writer-ops sync readiness (replaces namespace git status for apps).
 */

import { listPendingOutboxEntries } from "./SyncOutbox.js";
import { listRecentWriterConflicts } from "./writerConflict.js";

export interface WriterSyncReadyResult {
  ready: boolean;
  detail?: string;
}

export async function isAppWriterSyncReady(
  appId: string,
): Promise<WriterSyncReadyResult> {
  const pending = await listPendingOutboxEntries(appId);
  if (pending.length > 0) {
    return {
      ready: false,
      detail: `${pending.length} writer op(s) pending upload`,
    };
  }

  const conflicts = listRecentWriterConflicts(appId);
  if (conflicts.length > 0) {
    const latest = conflicts[conflicts.length - 1];
    return {
      ready: false,
      detail: `Writer conflict at ${latest.path} — resolve and re-upload`,
    };
  }

  return { ready: true };
}
