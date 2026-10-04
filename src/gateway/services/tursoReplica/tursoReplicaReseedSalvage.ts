/**
 * Keep local-only rows across a re-seed from cloud.
 *
 * A re-seed deletes `data.db` and downloads the Turso primary. Anything written locally
 * that never reached the primary — the exact rows a stuck or parked replica accumulates —
 * used to vanish with the file: `removeTursoReplicaLocalFiles` also clears the bootstrap
 * marker *and its snapshot*, and nothing replayed afterwards. The `pull` repair escalates
 * to a re-seed after three failed bootstraps, so a routine "refresh from cloud" silently
 * dropped unpushed rows.
 *
 * Two halves, deliberately split around the re-seed:
 *
 * 1. {@link salvageRowsInto} runs before the delete. `VACUUM INTO` first (atomic, cheap);
 *    when the file is damaged — the usual reason we are re-seeding — VACUUM refuses the
 *    whole file, so we fall back to copying table by table and skip only tables whose
 *    pages cannot be read. A file the engine aborts on is often perfectly readable by
 *    SQLite for most tables.
 *
 * 2. {@link replayLocalOnlyRows} runs after the fresh replica exists, and writes *through
 *    the sync engine* (TursoReplicaService), never beneath it — so replayed rows are
 *    recorded as ordinary pending changes and push on the next sync. It writes only the
 *    difference: rows whose primary key the cloud lacks, and rows whose local
 *    `_papr_updated_at` is newer than the cloud copy. Rows the cloud already has at the
 *    same or newer version are left alone — the cloud is authoritative for those.
 */

import * as fs from "fs";
import { isReplicaUserDataTable } from "./tursoReplicaBootstrapMarker.js";

export const RESEED_SALVAGE_SUFFIX = "-papr-reseed-salvage";

/** Minimal SQLite surface shared by better-sqlite3 and node:sqlite (tests). */
export interface SqlHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

/** The live replica, reached through the sync engine. */
export interface LiveReplica {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  write(statements: Array<{ sql: string; params: unknown[] }>): Promise<void>;
}

export interface SalvageResult {
  path: string | null;
  mode: "vacuum" | "per-table" | "none";
  tables: number;
  skipped: string[];
}

export interface ReplayResult {
  tables: number;
  inserted: number;
  updated: number;
  skipped: string[];
}

const UPDATED_AT = "_papr_updated_at";

/** User tables worth carrying across a re-seed. Sync-managed tables never are. */
export function isSalvageTable(name: string): boolean {
  return (
    isReplicaUserDataTable(name) && !name.startsWith("_papr_") && !name.startsWith("sqlite_")
  );
}

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function listTables(db: SqlHandle): Array<{ name: string; sql: string }> {
  return (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>
  ).filter((t) => isSalvageTable(t.name));
}

/**
 * Copy every readable user table of `source` into a new file at `targetPath`.
 *
 * `source` may be read-only. The per-table fallback writes through a separate handle from
 * `openTarget`, because ATTACH on a read-only connection inherits read-only.
 */
export function salvageRowsInto(
  source: SqlHandle,
  targetPath: string,
  openTarget: (path: string) => SqlHandle,
): SalvageResult {
  fs.rmSync(targetPath, { force: true });
  try {
    source.prepare("VACUUM INTO ?").run(targetPath);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      return { path: targetPath, mode: "vacuum", tables: listTables(source).length, skipped: [] };
    }
  } catch {
    /* damaged file — fall through to the per-table copy */
  }
  fs.rmSync(targetPath, { force: true });

  let tables: Array<{ name: string; sql: string }>;
  try {
    tables = listTables(source);
  } catch {
    return { path: null, mode: "none", tables: 0, skipped: [] };
  }
  const skipped: string[] = [];
  let copied = 0;
  const target = openTarget(targetPath);
  try {
    for (const table of tables) {
      try {
        const rows = source.prepare(`SELECT * FROM ${q(table.name)}`).all() as Array<
          Record<string, unknown>
        >;
        target.exec("BEGIN");
        target.exec(table.sql);
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const insert = target.prepare(
            `INSERT INTO ${q(table.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          );
          for (const row of rows) {
            insert.run(...cols.map((c) => row[c] as unknown));
          }
        }
        target.exec("COMMIT");
        copied += 1;
      } catch {
        try {
          target.exec("ROLLBACK");
        } catch {
          /* no transaction open */
        }
        skipped.push(table.name);
      }
    }
  } finally {
    target.close();
  }
  if (copied === 0) {
    fs.rmSync(targetPath, { force: true });
    return { path: null, mode: "none", tables: 0, skipped };
  }
  return { path: targetPath, mode: "per-table", tables: copied, skipped };
}

function newer(local: unknown, cloud: unknown): boolean {
  if (local === null || local === undefined) return false;
  if (cloud === null || cloud === undefined) return true;
  if (typeof local === "number" && typeof cloud === "number") return local > cloud;
  return String(local) > String(cloud);
}

function keyOf(row: Record<string, unknown>, pk: string[]): string {
  return JSON.stringify(pk.map((c) => row[c] ?? null));
}

/**
 * Write the rows of `snapshot` that the live replica lacks (or holds an older version of).
 * Tables absent from the live schema, or without a primary key, are skipped: the cloud
 * schema is authoritative after a re-seed, and without a key a row cannot be matched.
 */
export async function replayLocalOnlyRows(
  snapshot: SqlHandle,
  live: LiveReplica,
  options: { batchSize?: number } = {},
): Promise<ReplayResult> {
  const batchSize = options.batchSize ?? 200;
  const result: ReplayResult = { tables: 0, inserted: 0, updated: 0, skipped: [] };

  for (const { name } of listTables(snapshot)) {
    const liveInfo = (await live.query(`PRAGMA table_info(${q(name)})`)) as Array<{
      name: string;
      pk: number;
    }>;
    if (liveInfo.length === 0) {
      result.skipped.push(name);
      continue;
    }
    const pk = liveInfo
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name);
    const liveCols = new Set(liveInfo.map((c) => c.name));
    const snapCols = (snapshot.prepare(`PRAGMA table_info(${q(name)})`).all() as Array<{
      name: string;
    }>).map((c) => c.name);
    const shared = snapCols.filter((c) => liveCols.has(c));
    if (pk.length === 0 || !pk.every((c) => shared.includes(c))) {
      result.skipped.push(name);
      continue;
    }
    const hasVersion = shared.includes(UPDATED_AT);
    // Faithful copy, including `_papr_updated_at`, so the replayed row keeps the version
    // that justified replaying it (same rule as replayBootstrapSnapshot).
    const writeCols = shared;

    const liveRows = await live.query(
      `SELECT ${[...pk, ...(hasVersion ? [UPDATED_AT] : [])].map(q).join(", ")} FROM ${q(name)}`,
    );
    const liveVersion = new Map<string, unknown>();
    for (const row of liveRows) {
      liveVersion.set(keyOf(row, pk), hasVersion ? row[UPDATED_AT] : null);
    }

    const colList = writeCols.map(q).join(", ");
    const marks = writeCols.map(() => "?").join(", ");
    const pending: Array<{ sql: string; params: unknown[] }> = [];
    const flush = async () => {
      if (pending.length > 0) {
        await live.write(pending.splice(0, pending.length));
      }
    };

    const rows = snapshot
      .prepare(`SELECT ${shared.map(q).join(", ")} FROM ${q(name)}`)
      .all() as Array<Record<string, unknown>>;
    let touched = false;
    for (const row of rows) {
      const key = keyOf(row, pk);
      const params = writeCols.map((c) => row[c] ?? null);
      if (!liveVersion.has(key)) {
        pending.push({ sql: `INSERT OR IGNORE INTO ${q(name)} (${colList}) VALUES (${marks})`, params });
        result.inserted += 1;
      } else if (hasVersion && newer(row[UPDATED_AT], liveVersion.get(key))) {
        pending.push({ sql: `INSERT OR REPLACE INTO ${q(name)} (${colList}) VALUES (${marks})`, params });
        result.updated += 1;
      } else {
        continue;
      }
      touched = true;
      if (pending.length >= batchSize) await flush();
    }
    await flush();
    if (touched) result.tables += 1;
  }
  return result;
}
