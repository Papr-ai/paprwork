/** Real dependencies for settleProposalHolds (kept apart so the procedure is unit-testable). */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SettleDeps } from "./settleProposalHolds.js";

export async function defaultSettleDeps(): Promise<SettleDeps> {
  const { getDatabaseRegistryService, tursoNameForRecord, initializeDatabaseRegistry } = await import(
    "../DatabaseRegistryService.js"
  );
  await initializeDatabaseRegistry();
  const { openTursoPrimaryClient } = await import("../jobs/jobMigrationTursoSync.js");
  const { REMOTE_SCHEMA_MIGRATIONS_TABLE } = await import("../tursoPlatformSchema.js");
  const { reseedTursoReplicaFromRemote } = await import("./tursoReplicaProvision.js");
  const { writeLinkedDbViaTursoReplica, pushLinkedDbViaTursoReplica } = await import("./tursoReplicaRouting.js");
  const { QUARANTINE_DIR } = await import("../jobs/consolidateMigrationFolders.js");

  const record = (dbId: string) => {
    const r = getDatabaseRegistryService().getById(dbId);
    if (!r) throw new Error(`Database not found: ${dbId}`);
    return r;
  };

  return {
    async cloudAppliedIds(dbId) {
      const client = await openTursoPrimaryClient(tursoNameForRecord(record(dbId)));
      try {
        const r = await client.execute(`SELECT id FROM "${REMOTE_SCHEMA_MIGRATIONS_TABLE}"`);
        return new Set(r.rows.map((row) => String(row.id ?? "").replace(/\.sql$/, "")));
      } catch {
        return new Set();
      } finally {
        client.close();
      }
    },
    async latestProposalStatus(dbId, migrationFiles) {
      const { listAppIdsLinkingSyncKey } = await import("../tursoLinkedSources.js");
      const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
      const { cloudApiFetch } = await import("../../utils/cloudApiClient.js");
      let latest: { createdAt: string; status: string } | null = null;
      for (const appId of listAppIdsLinkingSyncKey(dbId, getPaprRoot())) {
        const resp = await cloudApiFetch(
          `/v1/cloud/apps/changes/outgoing?installedAppId=${encodeURIComponent(appId)}`,
        ).catch(() => null);
        if (!resp?.ok) continue;
        const body = (await resp.json().catch(() => ({}))) as {
          requests?: Array<{ status?: string; createdAt?: string; stagedPaths?: string[] | null }>;
        };
        for (const req of body.requests ?? []) {
          const staged = req.stagedPaths ?? [];
          if (!migrationFiles.some((f) => staged.some((p) => p.endsWith(`/${f}`)))) continue;
          const at = req.createdAt ?? "";
          if (!latest || at > latest.createdAt) latest = { createdAt: at, status: String(req.status ?? "") };
        }
      }
      return latest?.status ?? null;
    },
    // The hold journal is the record of held-period writes: discard the local
    // copy rather than salvaging it, or those rows would be replayed twice.
    rebuildLocalFromCloud: (dbId) => reseedTursoReplicaFromRemote(record(dbId), { localRows: "discard" }),
    async replayOne(source, statement) {
      await writeLinkedDbViaTursoReplica(source, statement.sql, statement.params ?? []);
    },
    push: (source) => pushLinkedDbViaTursoReplica(source, { skipMigrationConflictCheck: true }),
    async quarantineMigrations(hold) {
      for (const m of hold.migrations) {
        if (!m.migrationRoot) continue;
        const dir = path.join(m.migrationRoot, "migrations");
        const q = path.join(dir, QUARANTINE_DIR);
        await fs.mkdir(q, { recursive: true });
        await fs
          .rename(path.join(dir, `${m.migrationId}.sql`), path.join(q, `${m.migrationId}.sql.rejected`))
          .catch(() => {});
      }
    },
  };
}
