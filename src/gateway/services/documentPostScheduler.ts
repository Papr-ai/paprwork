/**
 * Debounced scheduling for document → Parse Post sync.
 *
 * WHY DEBOUNCE WHEN THE SERVER ALREADY GATES
 * ------------------------------------------
 * The Parse `beforeSave('Post')` similarity gate means a keystroke-level save
 * is *correct* without debounce — it computes similarity ≈ 1.0 and writes
 * nothing. So this is an efficiency measure, not a correctness one.
 *
 * Without it, every keystroke costs an HTTPS round-trip plus a server-side
 * cosine computation. With a 30s idle window, a user typing continuously
 * produces ONE request when they pause.
 *
 * Pending work is keyed by document id, so rapid edits to the same document
 * collapse into a single sync carrying the latest content — not a queue of
 * stale revisions.
 */

import { syncDocumentToPost } from "./documentPostSync.js";

/** Idle time before a document is synced. */
const DEBOUNCE_MS = 30_000;

interface PendingSync {
  timer: NodeJS.Timeout;
  title: string;
  content: string;
}

const pending = new Map<string, PendingSync>();

/**
 * Queue a document for sync after the idle window.
 *
 * Calling again for the same document replaces the pending payload and
 * restarts the timer — last write wins, which is what an editor wants.
 */
export function scheduleDocumentPostSync(input: {
  documentId: string;
  title: string;
  content: string;
}): void {
  const existing = pending.get(input.documentId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    const entry = pending.get(input.documentId);
    pending.delete(input.documentId);
    if (!entry) return;

    void syncDocumentToPost({
      documentId: input.documentId,
      title: entry.title,
      content: entry.content,
    }).then((result) => {
      if (result.reason === "created" || result.reason === "updated") {
        console.log(
          `[documentPostSync] ${result.reason} Post ${result.postId} for document ${input.documentId}`,
        );
      }
    });
  }, DEBOUNCE_MS);

  // Do not hold the process open for a pending sync — a queued document is
  // not a reason to block quit. The next edit re-queues it.
  timer.unref?.();

  pending.set(input.documentId, {
    timer,
    title: input.title,
    content: input.content,
  });
}

/**
 * Flush a document's pending sync immediately.
 *
 * Used on explicit save/close, and by tests that must not wait 30 seconds.
 */
export async function flushDocumentPostSync(
  documentId: string,
): Promise<void> {
  const entry = pending.get(documentId);
  if (!entry) return;

  clearTimeout(entry.timer);
  pending.delete(documentId);

  await syncDocumentToPost({
    documentId,
    title: entry.title,
    content: entry.content,
  });
}

/** Cancel a pending sync — e.g. the document was deleted before it fired. */
export function cancelDocumentPostSync(documentId: string): void {
  const entry = pending.get(documentId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(documentId);
}

/** Test helper: how many documents are awaiting sync. */
export function pendingDocumentSyncCount(): number {
  return pending.size;
}
