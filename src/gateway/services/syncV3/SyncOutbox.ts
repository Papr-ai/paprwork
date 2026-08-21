/**
 * Persist queued writer ops for offline retry (Sync V3 Phase 2).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppRepoOpFile } from "../../../core/types/appRepoWriterOps.js";
import { SYNC_OUTBOX_FILENAME } from "../../../core/types/appRepoWriterOps.js";
import { writeFileAtomic } from "../../../core/utils/atomicJsonWrite.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

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
}

function outboxPath(): string {
  return path.join(getPaprRoot(), "data", SYNC_OUTBOX_FILENAME);
}

async function readAllLines(): Promise<string[]> {
  try {
    const raw = await fs.readFile(outboxPath(), "utf8");
    return raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
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

export async function listOutboxEntries(
  appId?: string,
): Promise<SyncOutboxEntry[]> {
  const lines = await readAllLines();
  const entries: SyncOutboxEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SyncOutboxEntry;
      if (!appId || entry.appId === appId) {
        entries.push(entry);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return entries;
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

  const filePath = outboxPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
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

export async function markOutboxInflight(entryId: string): Promise<void> {
  await updateEntry(entryId, { status: "inflight" });
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
  const entries = await listOutboxEntries();
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }
  await updateEntry(entryId, {
    status: "pending",
    attempts: entry.attempts + 1,
    lastError: errorMessage.slice(0, 500),
  });
}

/** Permanent reject — do not block subsequent pushes for this app. */
export async function markOutboxDeadLetter(
  entryId: string,
  errorMessage: string,
): Promise<void> {
  await updateEntry(entryId, {
    status: "dead_letter",
    lastError: errorMessage.slice(0, 500),
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
}
