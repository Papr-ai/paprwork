/**
 * Self-heal for a replica whose WAL has grown far past its database.
 *
 * Plan A replicas never checkpoint: `TursoReplicaService.checkpoint()` is deliberately
 * empty because a checkpoint after push wedged the sync sidecars. So every write a replica
 * ever made stays in `data.db-wal`. A job that rewrites a few hundred rows every 15 minutes
 * grows it by tens of MB per run; after a few weeks one replica had a 19 GB WAL in front of
 * a 3.6 MB database.
 *
 * At that size opening the replica takes longer than the worker's request timeout. The
 * timeout SIGKILLs the shared sync worker, which fails every in-flight request on every
 * other database too, and the next request reopens the same file and times out again. One
 * oversized WAL takes all mini-app databases down in a 20-second restart loop.
 *
 * The cure is the same as for a parked replica: a fresh copy from the primary, keeping
 * rows that were never pushed (tursoReplicaReseedSalvage). A re-seed writes a new data.db
 * with an empty WAL, so the replica opens in milliseconds again.
 *
 * Bounded like the park heal: one attempt per path per session, only when online, only for
 * `syncMode: replica`. If it fails, nothing else changes.
 */

import * as fs from "fs";
import type { DatabaseRecord } from "../DatabaseRegistryService.js";

/** WAL size at which a replica is re-seeded. Override with PAPR_REPLICA_WAL_RESEED_BYTES (0 = off). */
export const DEFAULT_WAL_RESEED_BYTES = 512 * 1024 * 1024;

/**
 * The WAL must also dwarf the database. A large database with a proportionate WAL is
 * normal and is left alone; a WAL many times its database is history nobody will read.
 */
export const MIN_WAL_TO_DB_RATIO = 8;

export function resolveWalReseedBytes(
  raw: string | undefined = process.env.PAPR_REPLICA_WAL_RESEED_BYTES,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_WAL_RESEED_BYTES;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WAL_RESEED_BYTES;
  return Math.floor(parsed);
}

export interface OversizedWalReport {
  oversized: boolean;
  walBytes: number;
  dbBytes: number;
}

function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Two stat calls; cheap enough for every open. */
export function inspectOversizedReplicaWal(
  localPath: string,
  limitBytes: number = resolveWalReseedBytes(),
): OversizedWalReport {
  const walBytes = sizeOf(`${localPath}-wal`);
  const dbBytes = sizeOf(localPath);
  const oversized =
    limitBytes > 0 && walBytes >= limitBytes && walBytes >= dbBytes * MIN_WAL_TO_DB_RATIO;
  return { oversized, walBytes, dbBytes };
}

export interface OversizedWalHealDeps {
  isOnline(): boolean;
  getRecord(localPath: string): DatabaseRecord | undefined;
  reseed(record: DatabaseRecord): Promise<void>;
}

const attempted = new Set<string>();

async function defaultDeps(): Promise<OversizedWalHealDeps> {
  const [{ isTursoReplicaOnline }, { getDatabaseRegistryService }, { reseedTursoReplicaFromRemote }] =
    await Promise.all([
      import("../../utils/tursoReplicaEnabled.js"),
      import("../DatabaseRegistryService.js"),
      import("./tursoReplicaProvision.js"),
    ]);
  return {
    isOnline: isTursoReplicaOnline,
    getRecord: (p) => getDatabaseRegistryService().getByPath(p),
    reseed: (record) => reseedTursoReplicaFromRemote(record, { localRows: "keep" }),
  };
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Re-seed a replica with an oversized WAL from cloud once, keeping local-only rows.
 * Resolves to whether a re-seed ran and succeeded; never throws.
 */
export async function scheduleOversizedWalReseed(
  localPath: string,
  report: OversizedWalReport,
  depsOverride?: OversizedWalHealDeps,
): Promise<boolean> {
  if (attempted.has(localPath)) {
    return false;
  }
  try {
    const deps = depsOverride ?? (await defaultDeps());
    const record = deps.getRecord(localPath);
    if (!record || record.syncMode !== "replica") {
      return false;
    }
    if (!deps.isOnline()) {
      // Not counted as an attempt: the next open after reconnecting may try again.
      return false;
    }
    attempted.add(localPath);
    console.warn(
      `[TursoReplicaOversizedWal] Re-seeding ${record.dbId} from cloud: WAL is ` +
        `${mb(report.walBytes)} in front of a ${mb(report.dbBytes)} database (keeping local-only rows)`,
    );
    await deps.reseed(record);
    console.log(`[TursoReplicaOversizedWal] ${record.dbId} re-seeded; WAL reset`);
    return true;
  } catch (error) {
    console.error(
      `[TursoReplicaOversizedWal] Re-seed of ${localPath} failed: ${(error as Error).message}`,
    );
    return false;
  }
}

/** Test hook. */
export function resetOversizedWalAttemptsForTests(): void {
  attempted.clear();
}
