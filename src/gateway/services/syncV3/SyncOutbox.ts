/**
 * Persist queued writer ops for offline retry (Sync V3 Phase 2).
 *
 * Entries carry file contents inline, so this queue is only safe while every
 * entry stays small and the file stays drainable. Three guards keep it that way:
 *
 *  - **Bounded reads.** Lines stream and oversized ones are quarantined rather
 *    than parsed. A 1.6GB outbox previously aborted the gateway on launch.
 *  - **A cap at enqueue.** An op too large to push is rejected here instead of
 *    being written to disk and retried forever.
 *  - **Attempts advance on inflight.** An entry that kills the process mid-push
 *    still counts a try, so a poison entry dead-letters instead of blocking the
 *    queue head on every launch.
 *
 * Dead-lettered entries keep their paths but drop their payload: they are never
 * replayed, and retaining the bytes was itself a source of growth.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppRepoOpFile } from "../../../core/types/appRepoWriterOps.js";
import { SYNC_OUTBOX_FILENAME } from "../../../core/types/appRepoWriterOps.js";
import { writeFileAtomic } from "../../../core/utils/atomicJsonWrite.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import {
  compactJsonlDroppingOversized,
  MAX_OUTBOX_FILE_BYTES,
  MAX_OUTBOX_LINE_BYTES,
  readJsonlBounded,
} from "./outboxFile.js";

export type SyncOutboxEntryStatus =
  | "pending"
  | "inflight"
  | "acked"
  | "failed"
  | "dead_letter";

export interface SyncOutboxEntry {
  id: string;
  appId: string;
  idempotencyKey: string;
  files: AppRepoOpFile[];
  author: string;
  message: string;
  status: SyncOutboxEntryStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError?: string;
  commitSha?: string;
  /** Set when a dead-lettered entry's payload was dropped. */
  droppedFileCount?: number;
  droppedFilePaths?: string[];
}

/** An op too large to ever push. Permanent — never queue it. */
export class OutboxEntryTooLargeError extends Error {
  readonly byteLength: number;
  readonly limit: number;

  constructor(byteLength: number, limit: number) {
    super(
      `Writer op is ${Math.round(byteLength / (1024 * 1024))}MB, over the ` +
        `${Math.round(limit / (1024 * 1024))}MB queue limit. Store large ` +
        `assets with App Files so the bytes go to object storage instead.`,
    );
    this.name = "OutboxEntryTooLargeError";
    this.byteLength = byteLength;
    this.limit = limit;
  }
}

function outboxPath(): string {
  return path.join(getPaprRoot(), "data", SYNC_OUTBOX_FILENAME);
}

function quarantinePath(): string {
  return `${outboxPath()}.oversized`;
}

async function writeAllEntries(entries: SyncOutboxEntry[]): Promise<void> {
  const filePath = outboxPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body =
    entries.length > 0
      ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";
  await writeFileAtomic(filePath, body);
}

/**
 * Read the queue without letting a single entry bound memory.
 *
 * Oversized lines are moved out of the file on first sight: they cannot be
 * pushed, and leaving them in place would re-block every later read.
 */
export async function listOutboxEntries(
  appId?: string,
): Promise<SyncOutboxEntry[]> {
  const { lines, oversized } = await readJsonlBounded(outboxPath());

  if (oversized.length > 0) {
    const result = await compactJsonlDroppingOversized(outboxPath(), {
      quarantinePath: quarantinePath(),
    });
    console.warn(
      `[SyncOutbox] Quarantined ${result.quarantinedLines} oversized ` +
        `entr${result.quarantinedLines === 1 ? "y" : "ies"} ` +
        `(${Math.round(result.quarantinedBytes / (1024 * 1024))}MB) to ` +
        `${quarantinePath()}. These ops were too large to push; store large ` +
        `assets with App Files instead.`,
    );
  }

  const all: SyncOutboxEntry[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    try {
      all.push(JSON.parse(line) as SyncOutboxEntry);
      totalBytes += Buffer.byteLength(line, "utf8");
    } catch {
      /* skip corrupt line */
    }
  }

  const trimmed =
    totalBytes > MAX_OUTBOX_FILE_BYTES ? await trimToFileBudget(all) : all;

  return appId ? trimmed.filter((entry) => entry.appId === appId) : trimmed;
}

/**
 * Shed the oldest queued work once the queue outgrows its budget.
 *
 * Safe to drop because the queue is a retry aid, not the source of truth: a
 * flush re-collects from the local filesystem, and the OID cache only advances
 * on ack, so anything dropped here is collected again on the next flush. Left
 * unbounded, a long offline stretch across several apps can queue gigabytes
 * that no single process can then read.
 */
async function trimToFileBudget(
  entries: readonly SyncOutboxEntry[],
): Promise<SyncOutboxEntry[]> {
  const budget = Math.floor(MAX_OUTBOX_FILE_BYTES / 2);
  const kept: SyncOutboxEntry[] = [];
  let bytes = 0;

  // Newest first: recent entries reflect current disk state.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (bytes + size > budget && kept.length > 0) {
      continue;
    }
    kept.unshift(entry);
    bytes += size;
  }

  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    console.warn(
      `[SyncOutbox] Queue exceeded ${Math.round(
        MAX_OUTBOX_FILE_BYTES / (1024 * 1024),
      )}MB — dropped ${dropped} older queued op${dropped === 1 ? "" : "s"}. ` +
        `Their files are re-collected on the next flush.`,
    );
    await writeAllEntries(kept);
  }
  return kept;
}

/**
 * Drop pending entries this one supersedes.
 *
 * Each flush re-collects from disk, and the OID cache only advances on ack, so
 * an app that cannot reach the writer re-queues the same files on every flush.
 * That is how one queue reached 869 entries, most of them duplicates of each
 * other. An older pending entry whose paths are all covered here carries stale
 * content for those paths, so keeping it has no value.
 *
 * Only `pending` entries are considered: an `inflight` entry may already be
 * committed on the server, and a dead letter is a record, not work.
 */
function supersededPendingIds(
  entries: readonly SyncOutboxEntry[],
  appId: string,
  paths: ReadonlySet<string>,
): Set<string> {
  const superseded = new Set<string>();
  for (const entry of entries) {
    if (entry.appId !== appId || entry.status !== "pending") {
      continue;
    }
    if (
      entry.files.length > 0 &&
      entry.files.every((file) => paths.has(file.path))
    ) {
      superseded.add(entry.id);
    }
  }
  return superseded;
}

export async function appendOutboxEntry(input: {
  appId: string;
  files: AppRepoOpFile[];
  author: string;
  message: string;
  idempotencyKey?: string;
}): Promise<SyncOutboxEntry> {
  const now = new Date().toISOString();
  const entry: SyncOutboxEntry = {
    id: randomUUID(),
    appId: input.appId,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    files: input.files,
    author: input.author,
    message: input.message,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };

  const line = `${JSON.stringify(entry)}\n`;
  const byteLength = Buffer.byteLength(line, "utf8");
  if (byteLength > MAX_OUTBOX_LINE_BYTES) {
    throw new OutboxEntryTooLargeError(byteLength, MAX_OUTBOX_LINE_BYTES);
  }

  const filePath = outboxPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const existing = await listOutboxEntries();
  const superseded = supersededPendingIds(
    existing,
    input.appId,
    new Set(input.files.map((file) => file.path)),
  );

  if (superseded.size === 0) {
    await fs.appendFile(filePath, line, "utf8");
    return entry;
  }

  await writeAllEntries([
    ...existing.filter((item) => !superseded.has(item.id)),
    entry,
  ]);
  return entry;
}

async function updateEntry(
  entryId: string,
  patch: Partial<SyncOutboxEntry>,
): Promise<SyncOutboxEntry | null> {
  const entries = await listOutboxEntries();
  let updated: SyncOutboxEntry | null = null;
  const next = entries.map((entry) => {
    if (entry.id !== entryId) {
      return entry;
    }
    updated = {
      ...entry,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return updated;
  });
  if (!updated) {
    return null;
  }
  await writeAllEntries(next.filter((entry) => entry.status !== "acked"));
  return updated;
}

/**
 * Claim an entry for a push attempt.
 *
 * The attempt counter advances here rather than on failure so that an entry
 * which takes the process down mid-push still burns a try. Otherwise it stays
 * at zero attempts forever and blocks the queue head on every launch.
 */
export async function markOutboxInflight(entryId: string): Promise<void> {
  const entries = await listOutboxEntries();
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }
  await updateEntry(entryId, {
    status: "inflight",
    attempts: entry.attempts + 1,
  });
}

export async function markOutboxAcked(
  entryId: string,
  commitSha: string,
): Promise<void> {
  await updateEntry(entryId, { status: "acked", commitSha });
}

export async function markOutboxFailed(
  entryId: string,
  errorMessage: string,
): Promise<void> {
  await updateEntry(entryId, {
    status: "pending",
    lastError: errorMessage.slice(0, 500),
  });
}

/**
 * Permanent reject — do not block subsequent pushes for this app.
 *
 * The payload is dropped because a dead letter is never replayed, and keeping
 * the inline contents of every rejected op is how the queue grew unbounded.
 */
export async function markOutboxDeadLetter(
  entryId: string,
  errorMessage: string,
): Promise<void> {
  const entries = await listOutboxEntries();
  const entry = entries.find((item) => item.id === entryId);
  await updateEntry(entryId, {
    status: "dead_letter",
    lastError: errorMessage.slice(0, 500),
    files: [],
    droppedFileCount: entry?.droppedFileCount ?? entry?.files.length ?? 0,
    droppedFilePaths:
      entry?.droppedFilePaths ??
      entry?.files.slice(0, 20).map((file) => file.path),
  });
}

export async function listPendingOutboxEntries(
  appId?: string,
): Promise<SyncOutboxEntry[]> {
  const entries = await listOutboxEntries(appId);
  return entries.filter((entry) => entry.status === "pending");
}

export async function listDeadLetterOutboxEntries(
  appId?: string,
): Promise<SyncOutboxEntry[]> {
  const entries = await listOutboxEntries(appId);
  return entries.filter((entry) => entry.status === "dead_letter");
}

/** Test-only — reset outbox file. */
export async function clearSyncOutboxForTests(): Promise<void> {
  await fs.rm(outboxPath(), { force: true });
  await fs.rm(quarantinePath(), { force: true });
}
