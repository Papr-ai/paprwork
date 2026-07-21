/**
 * Keeps stored delegate_task tool results in sync with live sub-agent job status.
 */

import type { JobRecord } from "./jobs/types.js";
import { getStorageManager } from "./StorageManager.js";

export function patchStoredDelegateTaskResult(job: JobRecord): void {
  if (job.type !== "subagent" || !job.reportChatId?.trim()) {
    return;
  }
  if (job.status !== "completed" && job.status !== "failed") {
    return;
  }

  try {
    const patched = getStorageManager().patchDelegateTaskToolResult(
      job.reportChatId,
      job.id,
      {
        status: job.status,
        resultText: job.lastOutput,
        error: job.error,
        completedAt: job.completedAt,
      },
    );
    if (!patched) {
      console.warn(
        `[DelegationCompletionSync] No delegate_task tool call found for run ${job.id} in chat ${job.reportChatId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[DelegationCompletionSync] Failed to patch delegate_task for ${job.id}:`,
      err,
    );
  }
}
