/**
 * Self-heal for parked replicas.
 *
 * A path is parked after the sync engine aborts on it repeatedly and a sidecar reset did
 * not help — the cause is inside `data.db` (e.g. "database disk image is malformed").
 * Parking stops the crash loop, but on its own it leaves the database half-dead for the
 * rest of the session: reads fall back to cloud, mini-app writes fail with the parked
 * error, and nothing changes until someone runs a manual repair or restarts.
 *
 * The cure for a damaged replica file is a fresh copy from the primary. That used to be
 * unsafe to do automatically because a re-seed discarded unpushed rows; it now keeps them
 * (tursoReplicaReseedSalvage), so the heal is: re-seed once, in the background.
 *
 * Bounded on purpose: one attempt per path per session. If it fails the park stands and
 * the manual paths (repair_cloud_sync pull, restart) are unchanged.
 */

import type { DatabaseRecord } from "../DatabaseRegistryService.js";

export interface ParkHealDeps {
  isOnline(): boolean;
  getRecord(localPath: string): DatabaseRecord | undefined;
  reseed(record: DatabaseRecord): Promise<void>;
  delayMs: number;
}

const attempted = new Set<string>();

async function defaultDeps(): Promise<ParkHealDeps> {
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
    delayMs: 2_000,
  };
}

export function parkAutoHealEnabled(): boolean {
  return process.env.PAPR_REPLICA_PARK_AUTOHEAL !== "0";
}

/**
 * Re-seed a parked replica from cloud once, keeping local-only rows. Resolves to whether
 * a heal was attempted and succeeded; never throws.
 */
export async function scheduleParkedReplicaReseed(
  localPath: string,
  reason: string,
  depsOverride?: ParkHealDeps,
): Promise<boolean> {
  if (!parkAutoHealEnabled() || attempted.has(localPath)) {
    return false;
  }
  const deps = depsOverride ?? (await defaultDeps());
  const record = deps.getRecord(localPath);
  if (!record || record.syncMode !== "replica") {
    return false;
  }
  if (!deps.isOnline()) {
    // Not counted as an attempt: the next park (e.g. after reconnecting) may try again.
    return false;
  }
  attempted.add(localPath);
  // Let the request that hit the park return first; the re-seed restarts the sync worker.
  await new Promise((resolve) => setTimeout(resolve, deps.delayMs));
  try {
    console.warn(
      `[TursoReplicaParkHeal] Re-seeding parked replica ${record.dbId} from cloud ` +
        `(keeping local-only rows): ${reason}`,
    );
    await deps.reseed(record);
    console.log(`[TursoReplicaParkHeal] ${record.dbId} healed — sync and writes resumed`);
    return true;
  } catch (error) {
    console.error(
      `[TursoReplicaParkHeal] Re-seed of ${record.dbId} failed; it stays parked: ` +
        (error as Error).message,
    );
    return false;
  }
}

/** Test hook. */
export function resetParkHealAttemptsForTests(): void {
  attempted.clear();
}
