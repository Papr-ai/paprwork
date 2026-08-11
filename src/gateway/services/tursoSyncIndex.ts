/**
 * Workspace-level Turso sync index — one DB per owner with a row per linked replica.
 * Hint layer only: desktop compares index versions to cursors, then reconciles per data DB.
 */

import type { Client } from "@libsql/client";
import {
  createRemoteClient,
  quoteIdent,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import { SYNC_INDEX_TURSO_SHORT_NAME } from "./tursoDatabaseNaming.js";

export const SYNC_INDEX_TABLE = "sync_sources";

export interface SyncIndexEntry {
  shortName: string;
  version: number;
  updatedAt: string;
}

export async function ensureSyncIndexSchema(client: Client): Promise<void> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(SYNC_INDEX_TABLE)} (` +
      `short_name TEXT PRIMARY KEY, ` +
      `version INTEGER NOT NULL DEFAULT 0, ` +
      `updated_at TEXT NOT NULL DEFAULT (datetime('now'))` +
      `)`,
  );
}

/** Bump index row for a data DB short name; returns new version. */
export async function bumpSyncIndexEntry(
  client: Client,
  shortName: string,
): Promise<number | undefined> {
  const trimmed = shortName.trim();
  if (!trimmed) {
    return undefined;
  }
  await ensureSyncIndexSchema(client);
  await client.execute({
    sql:
      `INSERT INTO ${quoteIdent(SYNC_INDEX_TABLE)} (short_name, version, updated_at) ` +
      `VALUES (?, 1, datetime('now')) ` +
      `ON CONFLICT(short_name) DO UPDATE SET ` +
      `version = version + 1, updated_at = datetime('now')`,
    args: [trimmed],
  });
  return readSyncIndexVersion(client, trimmed);
}

export async function readSyncIndexVersion(
  client: Client,
  shortName: string,
): Promise<number | undefined> {
  try {
    const result = await client.execute({
      sql:
        `SELECT version FROM ${quoteIdent(SYNC_INDEX_TABLE)} ` +
        `WHERE short_name = ? LIMIT 1`,
      args: [shortName.trim()],
    });
    const value = result.rows[0]?.["version"];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readAllSyncIndexEntries(
  client: Client,
): Promise<SyncIndexEntry[]> {
  await ensureSyncIndexSchema(client);
  try {
    const result = await client.execute(
      `SELECT short_name, version, updated_at FROM ${quoteIdent(SYNC_INDEX_TABLE)}`,
    );
    const entries: SyncIndexEntry[] = [];
    for (const row of result.rows) {
      const shortName = String(row["short_name"] ?? "").trim();
      const version = Number(row["version"]);
      if (!shortName || !Number.isFinite(version)) {
        continue;
      }
      entries.push({
        shortName,
        version,
        updatedAt: String(row["updated_at"] ?? ""),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

export type FetchTursoCredentials = (
  databaseShortName: string,
) => Promise<TursoCredentials>;

export async function readSyncIndexVersionForShortName(
  fetchCredentials: FetchTursoCredentials,
  shortName: string,
): Promise<number | undefined> {
  const trimmed = shortName.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const creds = await fetchCredentials(SYNC_INDEX_TURSO_SHORT_NAME);
    const client = createRemoteClient(creds);
    try {
      await ensureSyncIndexSchema(client);
      return await readSyncIndexVersion(client, trimmed);
    } finally {
      client.close();
    }
  } catch {
    return undefined;
  }
}

export async function loadSyncIndexSnapshot(
  fetchCredentials: FetchTursoCredentials,
): Promise<SyncIndexEntry[]> {
  try {
    const creds = await fetchCredentials(SYNC_INDEX_TURSO_SHORT_NAME);
    const client = createRemoteClient(creds);
    try {
      return await readAllSyncIndexEntries(client);
    } finally {
      client.close();
    }
  } catch {
    return [];
  }
}

/** Bump index row for a data DB short name after push/write. */
export async function bumpSyncIndexForShortName(
  fetchCredentials: FetchTursoCredentials,
  shortName: string,
): Promise<number | undefined> {
  const trimmed = shortName.trim();
  if (!trimmed || trimmed === SYNC_INDEX_TURSO_SHORT_NAME) {
    return undefined;
  }
  try {
    const creds = await fetchCredentials(SYNC_INDEX_TURSO_SHORT_NAME);
    const client = createRemoteClient(creds);
    try {
      return await bumpSyncIndexEntry(client, trimmed);
    } finally {
      client.close();
    }
  } catch {
    return undefined;
  }
}
