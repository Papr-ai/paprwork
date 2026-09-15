/**
 * Job capability cards — what a job DOES, for discovery.
 *
 * Replaces the per-run database snapshot (see jobMemoryPolicy.ts) with one
 * small, stable memory per job.
 *
 * DESIGN RULE
 * -----------
 * Store a field only if (a) it cannot be computed exactly from local files, or
 * (b) it is needed where the filesystem is unreachable (cloud/published apps).
 *
 * `job.json` already holds name, type, command, schedule, appIds, dependsOn,
 * writeDbIds, requiredKeys and more — `list_jobs` returns all of it exactly,
 * instantly and always current. Copying configuration into memory would buy a
 * stale, fuzzy duplicate. So a card carries only what config cannot express:
 * the job's PURPOSE, its real OUTPUT TABLES with column meaning, its
 * MAGNITUDE and CADENCE, and search ALIASES so a query that does not know the
 * job's name still matches.
 *
 * STABILITY
 * ---------
 * The card contains NO run id and NO date. That is deliberate and is the
 * property that makes the write-on-change protocol work: a job running every
 * 15 minutes produces a byte-identical card each time, so the content hash is
 * unchanged and nothing is written. The old snapshot embedded `Run ID:` and
 * the old summary embedded the sync date, which is exactly why they wrote
 * unboundedly (5,721 rows / 26.5M chars in one namespace).
 */

import Database from "better-sqlite3";
import type { JobRecord } from "./jobs/types.js";

/** Tables that are replication plumbing, never job output. */
const SYSTEM_TABLES = new Set([
  "schema_migrations",
  "job_runs",
  "job_events",
  "sqlite_sequence",
]);
const SYSTEM_TABLE_PREFIXES = ["_papr_", "__turso_", "_turso_", "_litestream"];

/** Tables listed by name in the card. Beyond this they are summarised as a count. */
const MAX_NAMED_TABLES = 6;
/** Columns shown per table — enough to convey meaning, not a schema dump. */
const MAX_COLUMNS = 8;

export interface JobTableShape {
  table: string;
  rowCount: number;
  columns: string[];
}

export interface JobCapabilityCardInput {
  job: JobRecord;
  tables: JobTableShape[];
  /** Fraction of recent runs that succeeded, 0-1. Omit when unknown. */
  successRate?: number;
  /** How many runs successRate was computed over. */
  runSampleSize?: number;
}

export function isJobSystemTable(name: string): boolean {
  if (SYSTEM_TABLES.has(name)) {
    return true;
  }
  return SYSTEM_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Read table shapes (name, row count, columns) without reading row DATA.
 *
 * PRAGMA table_info gives columns without a SELECT, so no user content is
 * pulled into memory — the card describes the shape of the output, not the
 * output itself.
 */
export function readJobTableShapes(dbPath: string): JobTableShape[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .filter((name) => !isJobSystemTable(name));

    const shapes: JobTableShape[] = [];
    for (const table of names) {
      const quoted = `"${table.replace(/"/g, '""')}"`;
      try {
        const countRow = db
          .prepare(`SELECT COUNT(*) AS count FROM ${quoted}`)
          .get() as { count: number };
        const rowCount = countRow?.count ?? 0;
        if (rowCount === 0) {
          continue; // an empty table is not a capability
        }
        const cols = (
          db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name);
        shapes.push({ table, rowCount, columns: cols });
      } catch {
        // A single unreadable table must not lose the rest of the card.
      }
    }

    // Biggest tables first: row count is the best available proxy for which
    // table is the job's actual output, now that plumbing is excluded.
    return shapes.sort((a, b) => b.rowCount - a.rowCount);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function describeCadence(job: JobRecord): string {
  const schedule = job.schedule;
  if (!schedule?.enabled) {
    return "on demand";
  }
  if (schedule.cron) {
    return `on schedule ${schedule.cron}`;
  }
  if (schedule.intervalMs) {
    const minutes = Math.round(schedule.intervalMs / 60_000);
    return minutes >= 60
      ? `every ${Math.round(minutes / 60)}h`
      : `every ${minutes}m`;
  }
  return "scheduled";
}

function approximate(rowCount: number): string {
  if (rowCount < 1_000) return `~${rowCount}`;
  if (rowCount < 1_000_000) return `~${Math.round(rowCount / 1_000)}k`;
  return `~${(rowCount / 1_000_000).toFixed(1)}M`;
}

/**
 * Search aliases derived from table and column names.
 *
 * Purpose: let "something that knows when I'm free" match a job whose tables
 * are `calendar_events`. Column/table identifiers are the only vocabulary we
 * have without an LLM, so split them on separators and keep the distinct words.
 */
function deriveTopics(tables: JobTableShape[]): string[] {
  const words = new Set<string>();
  for (const t of tables.slice(0, MAX_NAMED_TABLES)) {
    for (const token of t.table.split(/[_\-.]/)) {
      const w = token.trim().toLowerCase();
      if (w.length > 2) words.add(w);
    }
  }
  return [...words].slice(0, 10);
}

/**
 * Build the card body. Deterministic: same inputs -> byte-identical output.
 */
export function buildJobCapabilityCard(input: JobCapabilityCardInput): string {
  const { job, tables } = input;
  const lines: string[] = [];

  const appPart =
    job.appIds?.length && job.appIds[0] !== "__standalone__"
      ? ` for app ${job.appIds[0]}`
      : "";
  lines.push(`${job.name} (job ${job.id}, ${job.type}, ${describeCadence(job)})`);

  if (job.delegationTask) {
    lines.push(job.delegationTask.trim().split("\n")[0].slice(0, 200));
  } else if (job.command) {
    lines.push(`Runs: ${job.command.slice(0, 160)}${appPart}`);
  }

  const named = tables.slice(0, MAX_NAMED_TABLES);
  if (named.length > 0) {
    lines.push("Produces:");
    for (const t of named) {
      const cols = t.columns.slice(0, MAX_COLUMNS).join(", ");
      const more =
        t.columns.length > MAX_COLUMNS
          ? `, +${t.columns.length - MAX_COLUMNS} more`
          : "";
      lines.push(
        `- ${t.table} (${approximate(t.rowCount)} rows): ${cols}${more}`,
      );
    }
    if (tables.length > named.length) {
      lines.push(`- plus ${tables.length - named.length} more table(s)`);
    }
  } else {
    lines.push("Produces: no persisted tables.");
  }

  if (job.dependsOn?.length) {
    lines.push(`Runs after: ${job.dependsOn.map((d) => d.jobId).join(", ")}`);
  }

  // Reliability is banded, not exact: an exact percentage would change on
  // almost every run and defeat the stable-hash property.
  if (
    typeof input.successRate === "number" &&
    typeof input.runSampleSize === "number" &&
    input.runSampleSize > 0
  ) {
    const pct = input.successRate;
    const band =
      pct >= 0.95 ? "reliable" : pct >= 0.7 ? "mostly reliable" : "flaky";
    lines.push(`Reliability: ${band} (last ${input.runSampleSize} runs)`);
  }

  const topics = deriveTopics(tables);
  if (topics.length) {
    lines.push(`Topics: ${topics.join(", ")}`);
  }

  return lines.join("\n");
}

/** Stable identity for a job's capability card — one key per job, forever. */
export function jobCapabilitySourceKey(jobId: string): string {
  return `job:${jobId}/capability`;
}
