/**
 * File and engine plumbing for tursoReplicaReseedSalvage — kept apart so the salvage and
 * replay logic stays testable without the Electron-built better-sqlite3 binary.
 */

import * as fs from "fs";
import Database from "better-sqlite3";
import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";
import {
  bootstrapSnapshotPath,
  readBootstrapPendingMarker,
} from "./tursoReplicaBootstrapMarker.js";
import {
  RESEED_SALVAGE_SUFFIX,
  replayLocalOnlyRows,
  salvageRowsInto,
  type ReplayResult,
  type SqlHandle,
} from "./tursoReplicaReseedSalvage.js";

const OWNER = "services/tursoReplica/tursoReplicaReseedSalvageIO";

export function reseedSalvagePath(dbPath: string): string {
  return `${dbPath}${RESEED_SALVAGE_SUFFIX}`;
}

function nonEmpty(p: string | undefined): p is string {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * Copy local rows aside before a re-seed deletes `data.db`. The worker must already be
 * closed. Returns the salvage path, or null when there was nothing readable to keep.
 *
 * A salvage left by an earlier re-seed whose replay never ran (network dropped mid-way)
 * is still the only copy of those rows: if the current file yields nothing it is reused,
 * otherwise it is kept under a timestamped name rather than overwritten.
 */
export function preserveLocalRowsForReseed(dbPath: string): string | null {
  const target = reseedSalvagePath(dbPath);
  const previous = nonEmpty(target) ? `${target}.${Date.now()}` : null;
  if (previous) fs.renameSync(target, previous);

  let salvaged: string | null = null;
  if (nonEmpty(dbPath)) {
    let source: Database.Database | null = null;
    try {
      source = openDiagnosticDatabase(Database, OWNER, dbPath, { readonly: true });
      const result = salvageRowsInto(
        source as unknown as SqlHandle,
        target,
        (p) => openDiagnosticDatabase(Database, OWNER, p) as unknown as SqlHandle,
      );
      salvaged = result.path;
      console.log(
        `[TursoReplicaReseed] Preserved local rows of ${dbPath} (${result.mode}, ` +
          `${result.tables} tables${result.skipped.length ? `, unreadable: ${result.skipped.join(", ")}` : ""})`,
      );
    } catch (error) {
      console.warn(
        `[TursoReplicaReseed] Could not read ${dbPath} before re-seed: ${(error as Error).message}`,
      );
    } finally {
      try {
        source?.close();
      } catch {
        /* already closed */
      }
    }
  }
  if (salvaged) return salvaged;

  // Nothing readable now — fall back to an older copy rather than lose the rows outright.
  if (previous) {
    fs.renameSync(previous, target);
    return target;
  }
  const markerSnapshot = readBootstrapPendingMarker(dbPath)?.snapshotPath ?? bootstrapSnapshotPath(dbPath);
  if (nonEmpty(markerSnapshot)) {
    fs.copyFileSync(markerSnapshot, target);
    return target;
  }
  return null;
}

/**
 * Replay salvaged rows into the freshly seeded replica through the sync engine. Never
 * throws: the re-seed itself succeeded. On failure the salvage file is kept on disk.
 */
export async function replaySalvagedRows(
  localPath: string,
  tursoDatabase: string,
  salvagePath: string,
): Promise<ReplayResult | null> {
  const { getTursoReplicaService } = await import("./TursoReplicaService.js");
  const replica = getTursoReplicaService();
  let snapshot: Database.Database | null = null;
  try {
    snapshot = openDiagnosticDatabase(Database, OWNER, salvagePath, { readonly: true });
    const result = await replayLocalOnlyRows(snapshot as unknown as SqlHandle, {
      query: async (sql, params) =>
        (await replica.runQuery({ localPath, tursoDatabase, sql, params })).rows as Array<
          Record<string, unknown>
        >,
      write: async (statements) => {
        await replica.runStatements({ localPath, tursoDatabase, statements });
      },
    });
    snapshot.close();
    snapshot = null;
    fs.rmSync(salvagePath, { force: true });
    console.log(
      `[TursoReplicaReseed] Kept local-only rows after re-seed of ${localPath}: ` +
        `${result.inserted} inserted, ${result.updated} newer versions restored ` +
        `across ${result.tables} tables`,
    );
    return result;
  } catch (error) {
    console.error(
      `[TursoReplicaReseed] Replay after re-seed failed for ${localPath}; local rows kept at ` +
        `${salvagePath}: ${(error as Error).message}`,
    );
    return null;
  } finally {
    try {
      snapshot?.close();
    } catch {
      /* already closed */
    }
  }
}
