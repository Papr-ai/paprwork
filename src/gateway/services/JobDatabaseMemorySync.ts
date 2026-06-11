/**
 * Sync job SQLite database snapshots to Papr Memory after successful runs.
 *
 * Job logs and agent prose are poor memory candidates. Structured rows in
 * ~/Papr/jobs/{id}/data/data.db are the durable output worth indexing.
 */

import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import Papr from "@papr/memory";
import { getApiKey } from "../utils/keyResolver.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import type { JobRecord } from "./jobs/types.js";
import { isSleepCycleJobName } from "./SleepCycleService.js";

const SYSTEM_TABLES = new Set([
  "schema_migrations",
  "job_runs",
  "job_events",
  "sqlite_sequence",
]);

const MAX_TABLES = 8;
const MAX_ROWS_PER_TABLE = 15;
const MAX_TOTAL_CHARS = 8000;
const MAX_CELL_CHARS = 500;

export interface JobDatabaseSnapshotInput {
  job: JobRecord;
  runId: string;
  jobDir: string;
}

export interface JobDatabaseSnapshotResult {
  synced: boolean;
  tableCount: number;
  reason?: string;
}

interface TableSnapshot {
  table: string;
  rowCount: number;
  sampleRows: Record<string, unknown>[];
}

function truncateCell(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}…`;
  }
  return value;
}

function listUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  return rows
    .map((row) => row.name)
    .filter((name) => !SYSTEM_TABLES.has(name));
}

function snapshotTable(
  db: Database.Database,
  tableName: string,
): TableSnapshot | null {
  const quoted = `"${tableName.replace(/"/g, '""')}"`;
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
    .get() as { count: number };
  const rowCount = countRow.count ?? 0;
  if (rowCount === 0) {
    return null;
  }

  const rawRows = db
    .prepare(`SELECT * FROM ${quoted} LIMIT ?`)
    .all(MAX_ROWS_PER_TABLE) as Record<string, unknown>[];

  const sampleRows = rawRows.map((row) => {
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      trimmed[key] = truncateCell(value);
    }
    return trimmed;
  });

  return { table: tableName, rowCount, sampleRows };
}

export function buildJobDatabaseSnapshotContent(
  job: JobRecord,
  runId: string,
  snapshots: TableSnapshot[],
): string {
  const header = [
    `Job database snapshot: ${job.name}`,
    `Job ID: ${job.id}`,
    `Run ID: ${runId}`,
    `Type: ${job.type}`,
    "",
  ].join("\n");

  const body = snapshots
    .map((snapshot) => {
      const truncatedNote =
        snapshot.rowCount > snapshot.sampleRows.length
          ? ` (showing ${snapshot.sampleRows.length} of ${snapshot.rowCount} rows)`
          : "";
      return [
        `## Table: ${snapshot.table}${truncatedNote}`,
        "```json",
        JSON.stringify(snapshot.sampleRows, null, 2),
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const content = `${header}\n${body}`;
  if (content.length <= MAX_TOTAL_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_TOTAL_CHARS)}\n\n[... truncated for memory limits ...]`;
}

export function extractJobDatabaseSnapshots(
  dbPath: string,
): TableSnapshot[] | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const tables = listUserTables(db).slice(0, MAX_TABLES);
    const snapshots: TableSnapshot[] = [];
    for (const table of tables) {
      const snapshot = snapshotTable(db, table);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function syncJobDatabaseToMemory(
  input: JobDatabaseSnapshotInput,
): Promise<JobDatabaseSnapshotResult> {
  if (isSleepCycleJobName(input.job.name)) {
    return { synced: false, tableCount: 0, reason: "sleep_cycle_skipped" };
  }

  const dbPath = path.join(input.jobDir, "data", "data.db");
  try {
    await fs.access(dbPath);
  } catch {
    return { synced: false, tableCount: 0, reason: "no_database" };
  }

  const stat = await fs.stat(dbPath);
  if (stat.size === 0) {
    return { synced: false, tableCount: 0, reason: "empty_database" };
  }

  const snapshots = extractJobDatabaseSnapshots(dbPath);
  if (!snapshots || snapshots.length === 0) {
    return { synced: false, tableCount: 0, reason: "no_user_data" };
  }

  const apiKey = await getApiKey("PAPR_API_KEY");
  if (!apiKey) {
    return { synced: false, tableCount: snapshots.length, reason: "no_api_key" };
  }

  const content = buildJobDatabaseSnapshotContent(
    input.job,
    input.runId,
    snapshots,
  );

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 30000,
  });

  const userId = getPaprUserId();

  try {
    await client.memory.add({
      content,
      ...(userId ? { user_id: userId } : {}),
      metadata: {
        role: "assistant",
        category: "fact",
        customMetadata: {
          source: "job_database_snapshot",
          jobId: input.job.id,
          jobName: input.job.name,
          jobType: input.job.type,
          runId: input.runId,
          tables: snapshots.map((s) => s.table).join(","),
          tableCount: String(snapshots.length),
        },
      },
    });
    return { synced: true, tableCount: snapshots.length };
  } catch (error) {
    console.warn(
      `[JobDatabaseMemorySync] Failed to sync job ${input.job.id}:`,
      error,
    );
    return {
      synced: false,
      tableCount: snapshots.length,
      reason: error instanceof Error ? error.message : "sync_failed",
    };
  }
}
