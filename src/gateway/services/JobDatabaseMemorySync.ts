/**
 * Sync job SQLite database snapshots to Papr Memory after successful runs.
 *
 * Job logs and agent prose are poor memory candidates. Structured rows in
 * ~/Papr/jobs/{id}/data/data.db are the durable output worth indexing.
 *
 * Produces up to TWO memory items per sync:
 * 1. Raw snapshot (content_type: "job_database_snapshot") — sample rows as JSON.
 *    DISABLED BY DEFAULT — see jobMemoryPolicy.ts.
 * 2. Human summary (content_type: "job_database_summary") — row counts, key
 *    records, column highlights.
 *
 * NOTE: an earlier version of this comment claimed the summary was "searchable
 * by the sleep agent for entity enrichment". That was never true —
 * SleepCycleService contains no memory search at all, and no search call site
 * filters for these content types. The supported discovery path is the
 * capability card (jobCapabilityCard.ts), which create_job reads directly.
 */

import { openDiagnosticDatabase } from "./databaseDiagnostics/sqlite.js";

import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import Papr from "@papr/memory";
import { getApiKey } from "../utils/keyResolver.js";
import { paprMemoryScopeSpread } from "../utils/memoryScopeResolver.js";
import type { JobRecord } from "./jobs/types.js";
import { isSleepCycleJobName } from "./SleepCycleService.js";
import { isRawJobDatabaseMemorySyncEnabled } from "./jobMemoryPolicy.js";
import { syncJobCapabilityCard } from "./jobCapabilityStore.js";

const SYSTEM_TABLES = new Set([
  "schema_migrations",
  "job_runs",
  "job_events",
  "sqlite_sequence",
]);

/**
 * Replication/CDC plumbing that is never job output.
 *
 * These were NOT excluded before, and because `_` and `__` sort ahead of
 * letters, `ORDER BY name` + MAX_TABLES=8 gave them the whole budget. The
 * "Calendar Reader" job stored `_papr_sync_log` (1.7M rows of change events)
 * and never stored `calendar_events` at all.
 */
const SYSTEM_TABLE_PREFIXES = ["_papr_", "__turso_", "_turso_", "_litestream"];

function isSystemTable(name: string): boolean {
  if (SYSTEM_TABLES.has(name)) {
    return true;
  }
  return SYSTEM_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

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
  summarySynced?: boolean;
  reason?: string;
}

export interface TableSnapshot {
  table: string;
  rowCount: number;
  columns: string[];
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
    .filter((name) => !isSystemTable(name));
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

  const columns =
    rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

  const sampleRows = rawRows.map((row) => {
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      trimmed[key] = truncateCell(value);
    }
    return trimmed;
  });

  return { table: tableName, rowCount, columns, sampleRows };
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

/**
 * Build a human-readable summary of database tables.
 *
 * Example output:
 *   Meeting Summarizer — Database Summary (2026-06-18)
 *   - meetings: 65 rows, 8 columns (title, attendees, summary, date, ...).
 *     Recent: "Revenue Reimagined Q3 Planning" (2026-06-17), "Papr Product Review" (2026-06-16).
 *   - calendar_events: 292 rows, 6 columns (title, start, end, ...).
 */
export function buildTableSummary(
  job: JobRecord,
  snapshots: TableSnapshot[],
): string {
  const today = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `${job.name} — Database Summary (${today})`,
    "",
  ];

  for (const snap of snapshots) {
    const colPreview = snap.columns.slice(0, 6).join(", ");
    const colSuffix = snap.columns.length > 6 ? ", ..." : "";
    let line = `- **${snap.table}**: ${snap.rowCount} rows, ${snap.columns.length} columns (${colPreview}${colSuffix}).`;

    // Add a "Recent:" preview from sample rows — pick a name/title column
    const titleCol = snap.columns.find((c) =>
      /^(title|name|subject|label|company|email|display_name)$/i.test(c),
    );
    const dateCol = snap.columns.find((c) =>
      /^(date|created_at|updated_at|timestamp|start|start_date|created|sync_date)$/i.test(c),
    );

    if (titleCol && snap.sampleRows.length > 0) {
      const previews = snap.sampleRows
        .slice(0, 3)
        .map((row) => {
          const t = String(row[titleCol] ?? "").slice(0, 80);
          const d = dateCol && row[dateCol] ? ` (${String(row[dateCol]).slice(0, 10)})` : "";
          return `"${t}"${d}`;
        })
        .join(", ");
      line += `\n  Recent: ${previews}.`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

export function extractJobDatabaseSnapshots(
  dbPath: string,
): TableSnapshot[] | null {
  let db: Database.Database | null = null;
  try {
    db = openDiagnosticDatabase(Database, "services/JobDatabaseMemorySync", dbPath, { readonly: true });
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

  // Shared content-hash gate (also used by event-driven DatabaseMemorySync):
  // skip when the database content hasn't changed since the last memory sync.
  const { shouldSyncDatabaseToMemory, recordDatabaseMemorySynced } = await import(
    "./DatabaseMemorySync.js"
  );
  const contentGate = shouldSyncDatabaseToMemory(dbPath);
  if (!contentGate.changed) {
    return { synced: false, tableCount: snapshots.length, reason: "content_unchanged" };
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

  const syncDate = todayISO();
  const tableNames = snapshots.map((s) => s.table).join(",");

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 30000,
  });

  let snapshotSynced = false;
  let summarySynced = false;
  const memoryScope = await paprMemoryScopeSpread();

  const { reserveMemoryWrite } = await import("./memoryWriteGuard.js");

  // 1. Store raw snapshot (existing behavior + new metadata)
  //
  // Content-hash guard: the per-database gate above is check-then-act against
  // a state file written only after the network round-trip, so concurrent job
  // runs both observe "changed" and both write. Measured groups feabf6be,
  // 4fe06e85 and b7bad86b are job_database_snapshot rows created within the
  // same second.
  //
  // A skip counts as SYNCED, not failed: the content is already in memory, so
  // reporting failure here would mark the run sync_failed and invite a retry
  // that writes nothing.
  //
  // DISABLED BY DEFAULT (see jobMemoryPolicy.ts). This payload embeds the run
  // id, so its hash changes every run and the guard above can never suppress
  // it -- 3,077 rows / ~24M chars in one namespace, with no reader that
  // targets it. Set PAPR_JOB_RAW_DB_MEMORY_SYNC=1 to restore.
  const snapshotReservation = !isRawJobDatabaseMemorySyncEnabled()
    ? null
    : reserveMemoryWrite(content, "job_database_snapshot");
  if (!snapshotReservation) {
    // Not an error: the capability card below is the supported replacement.
    snapshotSynced = false;
  } else if (!snapshotReservation.proceed) {
    snapshotSynced = true;
  } else {
    try {
      await client.memory.add({
        content,
        ...memoryScope,
        metadata: {
          role: "assistant",
          category: "fact",
          customMetadata: {
            source: "job_database_snapshot",
            content_type: "job_database_snapshot",
            sync_date: syncDate,
            jobId: input.job.id,
            jobName: input.job.name,
            jobType: input.job.type,
            runId: input.runId,
            tables: tableNames,
            tableCount: String(snapshots.length),
          },
        },
      });
      snapshotReservation.commit();
      snapshotSynced = true;
    } catch (error) {
      snapshotReservation.release();
      console.warn(
        `[JobDatabaseMemorySync] Failed to sync snapshot for job ${input.job.id}:`,
        error,
      );
    }
  }

  // 2. Capability card — one stable memory per job, updated in place.
  //
  // Replaces the old job_database_summary, which embedded the sync date in
  // its content and therefore re-wrote every day even when the database was
  // unchanged. The card contains no date and no run id, so an unchanged job
  // produces a byte-identical body and writes nothing.
  //
  // This is also the ONLY job memory with a reader: create_job searches these
  // before creating a job, to surface an existing job that already does the
  // work (see findSimilarJobCapabilities).
  const cardResult = await syncJobCapabilityCard({
    job: input.job,
    jobDir: input.jobDir,
  });
  summarySynced = cardResult.written || cardResult.reason === "unchanged";

  if (!snapshotSynced && !summarySynced) {
    return {
      synced: false,
      tableCount: snapshots.length,
      summarySynced: false,
      reason: "sync_failed",
    };
  }

  recordDatabaseMemorySynced(dbPath, contentGate.hash);

  return {
    synced: snapshotSynced,
    tableCount: snapshots.length,
    summarySynced,
  };
}
