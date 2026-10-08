/**
 * Publish procedure for databases held by a breaking migration (Phase 2).
 * Runs right after the app's code commit, per held database:
 *
 *   3. migrate the cloud directly — one transaction per migration, ledger-aware,
 *      so a retry skips what already landed (S3b);
 *   4. verify the cloud table set matches the local copy — on mismatch stop,
 *      keep the hold (old code and old schema stay consistent on the cloud);
 *   6. rebuild the local copy from the cloud, replay the hold journal, upload,
 *      release the hold (S3c).
 *
 * Step 5 (switch the host to the new commit) is done once per app by the caller.
 * Every step checks state first, so the whole procedure is safe to re-run.
 */

import type { AppDataSource } from "../appDataSources.js";
import {
  getReplicaPublishHold,
  holdPurpose,
  markHoldReplayPushed,
  readHoldJournal,
  releaseReplicaPublishHold,
  withHoldBypass,
  type ReplicaPublishHold,
} from "./replicaPublishHold.js";

export interface HeldPublishDeps {
  migrateCloud(hold: ReplicaPublishHold, tursoDatabase: string): Promise<string[]>;
  /** Schema signatures, one per user table: `name(col1,col2,…)` (column-level compare). */
  listCloudTables(tursoDatabase: string): Promise<string[]>;
  listLocalTables(source: AppDataSource): Promise<string[]>;
  rebuildLocalFromCloud(dbId: string): Promise<void>;
  replay(source: AppDataSource, statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  push(source: AppDataSource): Promise<{ ok: boolean; error?: string }>;
}

export interface HeldPublishResult {
  dbId: string;
  migrated: string[];
  replayed: number;
  ok: boolean;
  error?: string;
}

export class HeldPublishVerifyError extends Error {
  constructor(readonly dbId: string, readonly cloudOnly: string[], readonly localOnly: string[]) {
    super(
      `Cloud schema for ${dbId} doesn't match after migration ` +
        `(cloud only: ${cloudOnly.join(", ") || "none"}; local only: ${localOnly.join(", ") || "none"}). ` +
        "The hold stays; nothing was switched over.",
    );
    this.name = "HeldPublishVerifyError";
  }
}

export async function publishHeldDatabase(
  hold: ReplicaPublishHold,
  tursoDatabase: string,
  deps: HeldPublishDeps,
): Promise<HeldPublishResult> {
  const dbId = hold.dbId ?? hold.localPath;
  const source: AppDataSource = {
    id: `publish:${dbId}`,
    type: "sqlite",
    dbId: hold.dbId,
    alias: "publish",
    dbPath: hold.localPath,
    tables: [],
    linkedAt: hold.since,
  };

  if (holdPurpose(hold) === "proposal") {
    // Defense in depth: a teammate's proposal reaches the cloud only through the
    // publisher's approval, never through this desktop's publish.
    throw new Error(
      `Database ${dbId} holds a proposed schema change; it reaches the cloud when the proposal is approved.`,
    );
  }
  return withHoldBypass(hold.localPath, async () => {
    // 3. Cloud migration (idempotent per migration id).
    const migrated = await deps.migrateCloud(hold, tursoDatabase);

    // 4. Verify before anything local changes.
    const [cloud, local] = await Promise.all([
      deps.listCloudTables(tursoDatabase),
      deps.listLocalTables(source),
    ]);
    const cloudSet = new Set(cloud);
    const localSet = new Set(local);
    const cloudOnly = cloud.filter((t) => !localSet.has(t));
    const localOnly = local.filter((t) => !cloudSet.has(t));
    if (cloudOnly.length > 0 || localOnly.length > 0) {
      throw new HeldPublishVerifyError(dbId, cloudOnly, localOnly);
    }

    // 6. Rebuild from cloud, replay held-period writes, upload, release.
    const journal = readHoldJournal(hold.localPath);
    if (getReplicaPublishHold(hold.localPath)?.replayPushedAt) {
      // A previous run already uploaded the replay and stopped before releasing.
      // Replaying again would duplicate rows (S6), so just finish.
      releaseReplicaPublishHold(hold.localPath);
      return { dbId, migrated, replayed: 0, ok: true };
    }
    if (hold.dbId) {
      await deps.rebuildLocalFromCloud(hold.dbId);
    }
    if (journal.length > 0) {
      await deps.replay(source, journal.map((e) => ({ sql: e.sql, params: e.params })));
      const pushed = await deps.push(source);
      if (!pushed.ok) {
        // Journal and hold are kept: a retry rebuilds again and replays the same writes.
        throw new Error(`Upload after replay failed for ${dbId}: ${pushed.error ?? "push failed"}`);
      }
      markHoldReplayPushed(hold.localPath);
    } else {
      // No held writes: still run one push so the replica's "held for publish"
      // push error and pending flag clear (QA: status stayed "pending" after release).
      await deps.push(source).catch(() => ({ ok: false }));
    }
    releaseReplicaPublishHold(hold.localPath);
    return { dbId, migrated, replayed: journal.length, ok: true };
  });
}

/** Real dependencies (gateway). Kept separate so the procedure is unit-testable. */
export async function defaultHeldPublishDeps(): Promise<HeldPublishDeps> {
  const { openTursoPrimaryClient, applyAndRecordMigrationOnTursoPrimary } = await import(
    "../jobs/jobMigrationTursoSync.js"
  );
  const { listCloudUserTables, listReplicaUserTables } = await import("./tursoReplicaMigrationVerify.js");
  const { writeLinkedDbBatchViaTursoReplica, pushLinkedDbViaTursoReplica, queryLinkedDbViaTursoReplica } =
    await import("./tursoReplicaRouting.js");
  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  const { reseedTursoReplicaFromRemote } = await import("./tursoReplicaProvision.js");

  return {
    async migrateCloud(hold, tursoDatabase) {
      const client = await openTursoPrimaryClient(tursoDatabase);
      const applied: string[] = [];
      try {
        for (const m of hold.migrations) {
          if (!m.migrationRoot) {
            throw new Error(`Held migration ${m.migrationId} has no migration root`);
          }
          const r = await applyAndRecordMigrationOnTursoPrimary(client, m.migrationRoot, m.migrationId);
          if (r.applied) applied.push(m.migrationId);
        }
      } finally {
        client.close();
      }
      return applied;
    },
    async listCloudTables(tursoDatabase) {
      const tables = await listCloudUserTables(tursoDatabase);
      const client = await openTursoPrimaryClient(tursoDatabase);
      try {
        const sigs: string[] = [];
        for (const t of tables) {
          const r = await client.execute(`SELECT name FROM pragma_table_info(${sqlString(t)}) ORDER BY name`);
          sigs.push(signature(t, r.rows.map((row) => String(row.name))));
        }
        return sigs;
      } finally {
        client.close();
      }
    },
    async listLocalTables(source) {
      const tables = await listReplicaUserTables(source);
      const sigs: string[] = [];
      for (const t of tables) {
        const r = await queryLinkedDbViaTursoReplica(
          source,
          `SELECT name FROM pragma_table_info(${sqlString(t)}) ORDER BY name`,
          [],
          { pullBeforeRead: false },
        );
        sigs.push(signature(t, r.rows.map((row) => String((row as Record<string, unknown>).name))));
      }
      return sigs;
    },
    async rebuildLocalFromCloud(dbId) {
      const record = getDatabaseRegistryService().getById(dbId);
      if (!record) throw new Error(`Database not found: ${dbId}`);
      await reseedTursoReplicaFromRemote(record);
    },
    async replay(source, statements) {
      await writeLinkedDbBatchViaTursoReplica(source, statements);
    },
    push: (source) => pushLinkedDbViaTursoReplica(source, { skipMigrationConflictCheck: true }),
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Platform sync bookkeeping (`_papr_*` row-version columns) can exist on one side only; not app schema. */
export function signature(table: string, columns: string[]): string {
  const appColumns = columns.filter((c) => !c.startsWith("_papr_"));
  return `${table}(${[...appColumns].sort().join(",")})`;
}
