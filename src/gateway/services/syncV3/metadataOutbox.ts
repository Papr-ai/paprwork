/**
 * Retry queue for metadata dual-write failures (jobs index, databases registry).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "../../../core/utils/atomicJsonWrite.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import type { CloudAppMetaFile } from "../cloudSync/cloudAppMeta.js";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import type { JobConfigSlice } from "../jobs/jobRuntimeFields.js";
import type { AppDbConfigPayload } from "./appDbConfigUpload.js";

const OUTBOX_FILENAME = "metadata-outbox.jsonl";
const MAX_ATTEMPTS = 8;

export type MetadataOutboxKind =
  | "jobs"
  | "databases"
  | "app-runtime-meta"
  | "app-db-config";

export interface MetadataOutboxEntry {
  id: string;
  kind: MetadataOutboxKind;
  updatedAt: string;
  attempts: number;
  lastError?: string;
  jobs?: JobConfigSlice[];
  registry?: DatabasesRegistryFile;
  appId?: string;
  appRuntimeMeta?: CloudAppMetaFile;
  appDbConfig?: AppDbConfigPayload;
}

function outboxPath(): string {
  return path.join(getPaprRoot(), "data", OUTBOX_FILENAME);
}

async function readEntries(): Promise<MetadataOutboxEntry[]> {
  try {
    const raw = await fs.readFile(outboxPath(), "utf8");
    const entries: MetadataOutboxEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as MetadataOutboxEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function writeEntries(entries: MetadataOutboxEntry[]): Promise<void> {
  const filePath = outboxPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body =
    entries.length > 0
      ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";
  await writeFileAtomic(filePath, body);
}

export async function enqueueMetadataOutboxEntry(
  entry: Omit<MetadataOutboxEntry, "id" | "attempts">,
): Promise<void> {
  const entries = await readEntries();
  const filtered = entries.filter((existing) => {
    if (existing.kind !== entry.kind || existing.updatedAt !== entry.updatedAt) {
      return true;
    }
    if (
      entry.kind === "app-runtime-meta" &&
      existing.kind === "app-runtime-meta" &&
      existing.appId !== entry.appId
    ) {
      return true;
    }
    if (
      entry.kind === "app-db-config" &&
      existing.kind === "app-db-config" &&
      existing.appId !== entry.appId
    ) {
      return true;
    }
    return false;
  });
  filtered.push({
    id: randomUUID(),
    attempts: 0,
    ...entry,
  });
  await writeEntries(filtered);
}

async function removeEntry(entryId: string): Promise<void> {
  const entries = await readEntries();
  await writeEntries(entries.filter((entry) => entry.id !== entryId));
}

async function bumpAttempt(entryId: string, lastError: string): Promise<void> {
  const entries = await readEntries();
  const next = entries.map((entry) => {
    if (entry.id !== entryId) {
      return entry;
    }
    return {
      ...entry,
      attempts: entry.attempts + 1,
      lastError: lastError.slice(0, 300),
    };
  });
  await writeEntries(next.filter((entry) => entry.attempts < MAX_ATTEMPTS));
}

export async function flushMetadataOutbox(): Promise<{ flushed: number; failed: number }> {
  const entries = await readEntries();
  if (entries.length === 0) {
    return { flushed: 0, failed: 0 };
  }

  const {
    uploadJobsIndexToCloudDirect,
    uploadDatabasesRegistryToCloudDirect,
    uploadAppRuntimeMetaToCloudDirect,
  } = await import("./MetadataRegistryClient.js");
  const { uploadAppDbConfigToCloudDirect } = await import("./appDbConfigUpload.js");

  let flushed = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      let ok = false;
      if (entry.kind === "jobs" && entry.jobs) {
        ok = await uploadJobsIndexToCloudDirect(entry.jobs, entry.updatedAt);
      } else if (entry.kind === "databases" && entry.registry) {
        ok = await uploadDatabasesRegistryToCloudDirect(entry.registry, entry.updatedAt);
      } else if (
        entry.kind === "app-runtime-meta" &&
        entry.appId &&
        entry.appRuntimeMeta
      ) {
        ok = await uploadAppRuntimeMetaToCloudDirect(entry.appId, entry.appRuntimeMeta);
      } else if (
        entry.kind === "app-db-config" &&
        entry.appId &&
        entry.appDbConfig
      ) {
        ok = await uploadAppDbConfigToCloudDirect(entry.appId, entry.appDbConfig);
      }
      if (ok) {
        await removeEntry(entry.id);
        flushed += 1;
      } else {
        await bumpAttempt(entry.id, "upload rejected or unavailable");
        failed += 1;
      }
    } catch (err) {
      await bumpAttempt(entry.id, (err as Error).message);
      failed += 1;
    }
  }

  return { flushed, failed };
}

/** Test-only — reset metadata outbox file. */
export async function clearMetadataOutboxForTests(): Promise<void> {
  await fs.rm(outboxPath(), { force: true });
}
