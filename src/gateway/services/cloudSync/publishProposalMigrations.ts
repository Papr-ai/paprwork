/**
 * "Publish now" for a Maintainer/Admin whose change carries a database
 * migration: the same order as the publisher's own publish (held-publish,
 * option A) — database first, verified, then the code.
 *
 *   1. ask the server whether the publish would be allowed (nothing changes);
 *   2. upload this copy's pending rows, so nothing written under the old
 *      schema is lost;
 *   3. apply each new migration to the team's cloud database (idempotent per
 *      migration id, recorded in the cloud ledger);
 *   4. verify the schema on the cloud database;
 *   5. pull, so this copy has the new schema too.
 *
 * Only the team's shared data is handled here: that is the database the live
 * app reads. Anything else (own-data copies, per-user databases, offline)
 * returns a reason and the change goes to review as before.
 */

import type { AppDataSource } from "../appDataSources.js";

/** Kill switch: PAPR_PROPOSAL_DB_PUBLISH=0 sends every schema change to review (old behaviour). */
export function isProposalDatabasePublishEnabled(): boolean {
  const raw = process.env.PAPR_PROPOSAL_DB_PUBLISH?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

export interface ProposalMigration {
  dbId: string;
  migrationRoot: string;
  /** File name without .sql */
  migrationId: string;
}

export interface PublishMigrationsResult {
  /** True when every migration is on the cloud database and verified. */
  published: boolean;
  /** Why not (shown to the user; the change then goes to review). */
  reason?: string;
  migrated: string[];
}

export interface PublishMigrationsDeps {
  /** Server publish check: would a direct publish be allowed once the database is done? */
  checkAllowed(): Promise<{ allowed: boolean; reason?: string | null }>;
  /** Cloud database name for a shared database, or a reason it can't be migrated here. */
  resolveTarget(dbId: string): { tursoDatabase: string; source: AppDataSource } | { reason: string };
  online(): boolean;
  pushPending(source: AppDataSource): Promise<{ ok: boolean; error?: string }>;
  applyOnCloud(tursoDatabase: string, migrationRoot: string, migrationId: string): Promise<boolean>;
  verifyOnCloud(tursoDatabase: string, migrationRoot: string, migrationId: string): Promise<boolean>;
  pull(source: AppDataSource): Promise<void>;
}

export async function publishProposalMigrations(
  migrations: ProposalMigration[],
  deps: PublishMigrationsDeps,
): Promise<PublishMigrationsResult> {
  if (migrations.length === 0) return { published: true, migrated: [] };
  if (!isProposalDatabasePublishEnabled()) {
    return { published: false, migrated: [], reason: "Publishing database changes directly is turned off, so it was sent for review." };
  }
  if (!deps.online()) {
    return { published: false, migrated: [], reason: "Offline: the database change can't be applied right now, so it was sent for review." };
  }

  const byDb = new Map<string, ProposalMigration[]>();
  for (const m of migrations) {
    byDb.set(m.dbId, [...(byDb.get(m.dbId) ?? []), m]);
  }
  const targets = new Map<string, { tursoDatabase: string; source: AppDataSource }>();
  for (const dbId of byDb.keys()) {
    const t = deps.resolveTarget(dbId);
    if ("reason" in t) return { published: false, migrated: [], reason: t.reason };
    targets.set(dbId, t);
  }

  // Before touching the team's database: would the publish go through?
  const check = await deps.checkAllowed();
  if (!check.allowed) {
    return { published: false, migrated: [], reason: check.reason ?? "Publishing directly isn't allowed for this change." };
  }

  const migrated: string[] = [];
  for (const [dbId, list] of byDb) {
    const { tursoDatabase, source } = targets.get(dbId)!;
    const flushed = await deps.pushPending(source);
    if (!flushed.ok) {
      throw new Error(`Couldn't upload pending rows before the database change: ${flushed.error ?? "push failed"}`);
    }
    for (const m of [...list].sort((a, b) => a.migrationId.localeCompare(b.migrationId))) {
      if (await deps.applyOnCloud(tursoDatabase, m.migrationRoot, m.migrationId)) {
        migrated.push(m.migrationId);
      }
      if (!(await deps.verifyOnCloud(tursoDatabase, m.migrationRoot, m.migrationId))) {
        throw new Error(`${m.migrationId} was applied to the cloud database but its schema didn't verify`);
      }
    }
    await deps.pull(source);
  }
  return { published: true, migrated };
}

/** New migration files in a proposal: repo paths written under a migrations tree. */
export function proposalMigrationsFromWrites(
  writes: Iterable<string>,
  trees: ReadonlyArray<{ repoRelativeDir: string; dbId?: string; migrationRoot?: string }>,
): ProposalMigration[] {
  const out: ProposalMigration[] = [];
  const paths = [...writes];
  for (const tree of trees) {
    if (!tree.dbId || !tree.migrationRoot) continue;
    const prefix = `${tree.repoRelativeDir.replace(/\/+$/, "")}/`;
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const name = p.slice(prefix.length);
      if (name.includes("/") || !name.endsWith(".sql")) continue;
      out.push({ dbId: tree.dbId, migrationRoot: tree.migrationRoot, migrationId: name.replace(/\.sql$/, "") });
    }
  }
  return out;
}

/** Gateway dependencies. */
export async function defaultPublishMigrationsDeps(
  requestId: string,
  stagedPaths: string[],
): Promise<PublishMigrationsDeps> {
  const { cloudApiFetch } = await import("../../utils/cloudApiClient.js");
  const { getDatabaseRegistryService, tursoNameForRecord } = await import("../DatabaseRegistryService.js");
  const { isCollaboratorOnSharedDatabase } = await import("../sharedPrimaryTursoResolve.js");
  const { isTursoReplicaOnline } = await import("../../utils/tursoReplicaEnabled.js");
  const { openTursoPrimaryClient, applyAndRecordMigrationOnTursoPrimary } = await import(
    "../jobs/jobMigrationTursoSync.js"
  );
  const { migrationSatisfiedOnRemote } = await import("../jobs/jobMigrationLedgerSync.js");
  const { pushLinkedDbViaTursoReplica, pullLinkedDbViaTursoReplica } = await import(
    "../tursoReplica/tursoReplicaRouting.js"
  );

  const withClient = async <T>(db: string, fn: (c: Awaited<ReturnType<typeof openTursoPrimaryClient>>) => Promise<T>) => {
    const client = await openTursoPrimaryClient(db);
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  };

  return {
    async checkAllowed() {
      const resp = await cloudApiFetch(
        `/v1/cloud/apps/changes/${encodeURIComponent(requestId)}/publish-check`,
        { method: "POST", body: { stagedPaths }, timeoutMs: 20_000 },
      );
      if (resp.status === 404 || resp.status === 405) {
        return { allowed: false, reason: "The server can't publish database changes directly yet, so it was sent for review." };
      }
      if (!resp.ok) return { allowed: false, reason: `Publish check failed (${resp.status}).` };
      return (await resp.json()) as { allowed: boolean; reason?: string | null };
    },
    resolveTarget(dbId) {
      const record = getDatabaseRegistryService().getById(dbId);
      if (!record) return { reason: `Database ${dbId} isn't on this computer.` };
      if (record.isolation === "per-user") {
        return { reason: "This app keeps a separate database per person; its schema change needs the publisher." };
      }
      if (!isCollaboratorOnSharedDatabase(dbId)) {
        return { reason: "This copy uses its own data, so the team's database change goes through review." };
      }
      const source: AppDataSource = {
        id: `publish:${dbId}`,
        type: "sqlite",
        dbId,
        alias: "publish",
        dbPath: record.localPath,
        tables: [],
        linkedAt: record.createdAt,
      };
      return { tursoDatabase: tursoNameForRecord(record), source };
    },
    online: () => isTursoReplicaOnline(),
    pushPending: (source) => pushLinkedDbViaTursoReplica(source),
    applyOnCloud: (db, root, id) =>
      withClient(db, async (c) => (await applyAndRecordMigrationOnTursoPrimary(c, root, id)).applied),
    verifyOnCloud: (db, root, id) => withClient(db, (c) => migrationSatisfiedOnRemote(c, root, id)),
    async pull(source) {
      await pullLinkedDbViaTursoReplica(source);
    },
  };
}
