/**
 * Phase 3 genesis cutover — snapshot local SQLite, write genesis entry to workspace log.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";

import {
  filterSyncableTables,
  listUserTables,
} from "../tursoSyncBridgeCore.js";
import { computeSyncableTableFingerprints } from "../tursoTableFingerprint.js";
import { writeWorkspaceLogGenesis } from "./WorkspaceLogClient.js";
import {
  getWorkspaceLogCutoverRecord,
  markWorkspaceLogGenesisComplete,
} from "./workspaceLogCutoverState.js";

export function computeDbSnapshotHash(dbPath: string): {
  snapshotHash: string;
  tableCount: number;
} | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const fingerprints = computeSyncableTableFingerprints(db);
    const tableNames = filterSyncableTables(listUserTables(db)).sort();
    const hash = createHash("sha256");
    hash.update("workspace-log-genesis-v1|");
    for (const name of tableNames) {
      hash.update(`${name}:${fingerprints[name] ?? ""}|`);
    }
    return {
      snapshotHash: hash.digest("hex").slice(0, 32),
      tableCount: tableNames.length,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Idempotent — skips when cutover record already exists for replica. */
export async function ensureWorkspaceLogGenesisForDb(
  replicaId: string,
  dbPath: string,
  dbSourceId?: string,
): Promise<boolean> {
  const existing = await getWorkspaceLogCutoverRecord(replicaId);
  if (existing) {
    return true;
  }

  const snapshot = computeDbSnapshotHash(dbPath);
  if (!snapshot) {
    console.warn(
      `[WorkspaceLogGenesis] Cannot compute snapshot for ${replicaId} — skipping genesis`,
    );
    return false;
  }

  const response = await writeWorkspaceLogGenesis({
    replicaId,
    dbSourceId,
    snapshotHash: snapshot.snapshotHash,
    tableCount: snapshot.tableCount,
  });

  await markWorkspaceLogGenesisComplete({
    replicaId,
    snapshotHash: snapshot.snapshotHash,
    tableCount: snapshot.tableCount,
    genesisSeq: response.seq,
    cutoverAt: new Date().toISOString(),
  });

  console.log(
    `[WorkspaceLogGenesis] Genesis recorded for ${replicaId} ` +
      `(tables=${snapshot.tableCount}, seq=${response.seq})`,
  );
  return true;
}

export interface WorkspaceLogGenesisCutoverSummary {
  attempted: number;
  completed: number;
  skipped: number;
  failed: number;
  details: Array<{
    replicaId: string;
    dbPath: string;
    status: "completed" | "skipped" | "failed";
    error?: string;
  }>;
}

/** Run idempotent genesis for every Turso-linked replica in the active workspace. */
export async function runWorkspaceLogGenesisCutoverForAllLinkedSources(): Promise<WorkspaceLogGenesisCutoverSummary> {
  const { getPaprAppsRoot } = await import("../../../core/utils/paprRoot.js");
  const { discoverTursoLinkedSources } = await import("../tursoLinkedSources.js");
  const { resolveReplicaIdForLinkedSource } = await import("./workspaceLogSync.js");

  const sources = await discoverTursoLinkedSources(getPaprAppsRoot());
  const summary: WorkspaceLogGenesisCutoverSummary = {
    attempted: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const source of sources) {
    const replicaId = resolveReplicaIdForLinkedSource(source);
    if (!replicaId) {
      continue;
    }

    summary.attempted += 1;
    const existing = await getWorkspaceLogCutoverRecord(replicaId);
    if (existing) {
      summary.skipped += 1;
      summary.details.push({
        replicaId,
        dbPath: source.dbPath,
        status: "skipped",
      });
      continue;
    }

    try {
      const ok = await ensureWorkspaceLogGenesisForDb(
        replicaId,
        source.dbPath,
        source.alias ?? source.jobId,
      );
      if (ok) {
        summary.completed += 1;
        summary.details.push({
          replicaId,
          dbPath: source.dbPath,
          status: "completed",
        });
      } else {
        summary.failed += 1;
        summary.details.push({
          replicaId,
          dbPath: source.dbPath,
          status: "failed",
          error: "genesis skipped (empty or unreadable db)",
        });
      }
    } catch (error) {
      summary.failed += 1;
      summary.details.push({
        replicaId,
        dbPath: source.dbPath,
        status: "failed",
        error: (error as Error).message.slice(0, 200),
      });
    }
  }

  return summary;
}
