/**
 * One-time migration ledger backfill for legacy Turso replicas.
 *
 * When Turso schema already matches migrations/*.sql but _papr_schema_migrations
 * is empty, alignMigrationLedgers records satisfied migrations without replaying DDL.
 */

import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import path from "path";
import {
  filterSyncableTables,
  listUserTables,
} from "../tursoSyncBridgeCore.js";
import { resolveMigrationRootFromDbPath } from "../jobs/databaseMigrations.js";
import {
  alignMigrationLedgers,
  listRemoteAppliedMigrationIds,
  migrationSatisfiedOnRemote,
  REMOTE_SCHEMA_MIGRATIONS_TABLE,
} from "../jobs/jobMigrationLedgerSync.js";
import { listMigrationSqlFiles } from "../jobs/jobMigrationManifest.js";
import { shouldSkipMigrationForRemoteLedger } from "../jobs/migrationLedgerPolicy.js";
import { getPaprAppsRoot } from "../../../core/utils/paprRoot.js";
import {
  discoverTursoLinkedSources,
  type TursoLinkedSource,
} from "../tursoLinkedSources.js";
import { resolveReplicaIdForLinkedSource } from "./workspaceLogSync.js";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { mergeCloudActingUserBody } from "../../utils/cloudActingUser.js";
import type { TursoCredentials } from "../tursoSyncBridgeCore.js";
import { shipSchemaMigrationForDbPath } from "./shipSchemaMigrationLog.js";
import { isReplicaManagedDbPath } from "../tursoReplica/tursoReplicaFileGuard.js";

async function fetchTursoCredentialsForBackfill(
  replicaId: string,
  apiKey: string,
): Promise<TursoCredentials> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/databases/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(
          mergeCloudActingUserBody({ database: replicaId }),
        ),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Turso token request failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      tursoUrl?: string;
      authToken?: string;
    };
    if (!data.tursoUrl || !data.authToken) {
      throw new Error("Turso token response missing tursoUrl or authToken");
    }
    return { tursoUrl: data.tursoUrl, authToken: data.authToken };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Turso token request timed out after 60s");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveBackfillApiKey(explicit?: string): string {
  const key = explicit?.trim() ?? process.env.PAPR_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "PAPR_API_KEY not configured. Set env or use backfill:migration-ledgers:keychain",
    );
  }
  return key;
}

export interface MigrationLedgerSourcePreview {
  replicaId: string;
  appId: string;
  alias: string;
  dbPath: string;
  migrationRoot: string;
  remoteTableCount: number;
  localTableCount: number;
  remoteLedgerCount: number;
  alreadyLedgered: string[];
  wouldBackfill: string[];
  unsatisfied: string[];
  skippedMarkers: string[];
}

export interface MigrationLedgerBackfillDetail {
  replicaId: string;
  appId: string;
  alias: string;
  dbPath: string;
  status: "applied" | "preview" | "skipped" | "failed";
  preview?: MigrationLedgerSourcePreview;
  remoteBackfilled?: string[];
  localHydrated?: string[];
  localInferred?: string[];
  error?: string;
}

export interface MigrationLedgerBackfillSummary {
  dryRun: boolean;
  attempted: number;
  applied: number;
  previewed: number;
  skipped: number;
  failed: number;
  details: MigrationLedgerBackfillDetail[];
}

export interface MigrationLedgerBackfillOptions {
  dryRun?: boolean;
  appId?: string;
  replicaId?: string;
  all?: boolean;
  /** Ship unsatisfied migrations via workspace log before ledger backfill. */
  shipUnsatisfied?: boolean;
  /** Poll Turso after shipping schema (ms). 0 = skip wait. */
  waitAfterShipMs?: number;
  /** Use namespace-bound key from script env (bypasses keyResolver scope check). */
  apiKey?: string;
}

const JOE_COFFEE_APP_ID = "744f60d6-d57b-4be7-95fd-feb7115831b4";
const JOE_COFFEE_REPLICA_ID = "d-0ff146f4";

function countLocalSyncableTables(dbPath: string): number {
  if (isReplicaManagedDbPath(dbPath)) {
    return 0;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return filterSyncableTables(listUserTables(db)).length;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

async function countRemoteSyncableTables(
  tursoUrl: string,
  authToken: string,
): Promise<number> {
  const remote = createClient({ url: tursoUrl, authToken });
  try {
    const result = await remote.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    );
    // Synchronous mapping over an already-awaited result — safe to return
    // directly. Any async call here would need `await` so the finally does
    // not close the client mid-flight.
    return filterSyncableTables(
      result.rows.map((row) => String(row.name ?? "")),
    ).length;
  } finally {
    remote.close();
  }
}

export async function previewMigrationLedgerForSource(
  linked: TursoLinkedSource,
  remote: ReturnType<typeof createClient>,
): Promise<MigrationLedgerSourcePreview | null> {
  const replicaId = resolveReplicaIdForLinkedSource(linked);
  const migrationRoot = resolveMigrationRootFromDbPath(linked.dbPath);
  if (!replicaId || !migrationRoot) {
    return null;
  }

  const migrationIds = await listMigrationSqlFiles(migrationRoot);
  const remoteApplied = await listRemoteAppliedMigrationIds(remote);

  const alreadyLedgered: string[] = [];
  const wouldBackfill: string[] = [];
  const unsatisfied: string[] = [];
  const skippedMarkers: string[] = [];

  for (const migrationId of migrationIds) {
    if (shouldSkipMigrationForRemoteLedger(migrationId)) {
      skippedMarkers.push(migrationId);
      continue;
    }
    if (remoteApplied.has(migrationId)) {
      alreadyLedgered.push(migrationId);
      continue;
    }
    if (await migrationSatisfiedOnRemote(remote, migrationRoot, migrationId)) {
      wouldBackfill.push(migrationId);
    } else {
      unsatisfied.push(migrationId);
    }
  }

  const ledgerResult = await remote.execute(
    `SELECT COUNT(*) AS c FROM ${REMOTE_SCHEMA_MIGRATIONS_TABLE}`,
  );
  const remoteLedgerCount = Number(ledgerResult.rows[0]?.c ?? 0);

  return {
    replicaId,
    appId: linked.appId,
    alias: linked.alias ?? linked.jobId ?? replicaId,
    dbPath: linked.dbPath,
    migrationRoot,
    remoteTableCount: 0,
    localTableCount: countLocalSyncableTables(linked.dbPath),
    remoteLedgerCount,
    alreadyLedgered,
    wouldBackfill,
    unsatisfied,
    skippedMarkers,
  };
}

async function waitForRemoteSchemaApplied(
  tursoUrl: string,
  authToken: string,
  migrationRoot: string,
  migrationIds: readonly string[],
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  const remote = createClient({ url: tursoUrl, authToken });
  try {
    while (Date.now() < deadline) {
      let allSatisfied = true;
      for (const migrationId of migrationIds) {
        if (!(await migrationSatisfiedOnRemote(remote, migrationRoot, migrationId))) {
          allSatisfied = false;
          break;
        }
      }
      if (allSatisfied) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } finally {
    remote.close();
  }
}

function filterLinkedSources(
  sources: TursoLinkedSource[],
  options: MigrationLedgerBackfillOptions,
): TursoLinkedSource[] {
  const appId = options.appId?.trim();
  const replicaId = options.replicaId?.trim();

  if (!options.all && !appId && !replicaId) {
    return sources.filter((source) => source.appId === JOE_COFFEE_APP_ID);
  }

  return sources.filter((source) => {
    const rid = resolveReplicaIdForLinkedSource(source);
    if (appId && source.appId !== appId) {
      return false;
    }
    if (replicaId && rid !== replicaId) {
      return false;
    }
    return true;
  });
}

export async function runMigrationLedgerBackfill(
  options: MigrationLedgerBackfillOptions = {},
): Promise<MigrationLedgerBackfillSummary> {
  const dryRun = options.dryRun ?? false;
  const apiKey = resolveBackfillApiKey(options.apiKey);

  const { getDatabaseRegistryService } = await import("../DatabaseRegistryService.js");
  await getDatabaseRegistryService().initialize();

  const allSources = await discoverTursoLinkedSources(getPaprAppsRoot());
  const sources = filterLinkedSources(allSources, options);

  const summary: MigrationLedgerBackfillSummary = {
    dryRun,
    attempted: 0,
    applied: 0,
    previewed: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  if (sources.length === 0) {
    return summary;
  }

  for (const linked of sources) {
    const replicaId = resolveReplicaIdForLinkedSource(linked);
    const migrationRoot = resolveMigrationRootFromDbPath(linked.dbPath);
    if (!replicaId || !migrationRoot) {
      summary.skipped += 1;
      summary.details.push({
        replicaId: replicaId ?? "unknown",
        appId: linked.appId,
        alias: linked.alias ?? linked.jobId ?? "?",
        dbPath: linked.dbPath,
        status: "skipped",
        error: "no replica id or migrations folder",
      });
      continue;
    }

    summary.attempted += 1;

    let credentials;
    try {
      credentials = await fetchTursoCredentialsForBackfill(replicaId, apiKey);
    } catch (error) {
      summary.failed += 1;
      summary.details.push({
        replicaId,
        appId: linked.appId,
        alias: linked.alias ?? linked.jobId ?? replicaId,
        dbPath: linked.dbPath,
        status: "failed",
        error: (error as Error).message.slice(0, 200),
      });
      continue;
    }

    const remote = createClient({
      url: credentials.tursoUrl,
      authToken: credentials.authToken,
    });

    try {
      const preview = await previewMigrationLedgerForSource(linked, remote);
      if (!preview) {
        summary.skipped += 1;
        summary.details.push({
          replicaId,
          appId: linked.appId,
          alias: linked.alias ?? linked.jobId ?? replicaId,
          dbPath: linked.dbPath,
          status: "skipped",
          error: "preview failed",
        });
        continue;
      }

      preview.remoteTableCount = await countRemoteSyncableTables(
        credentials.tursoUrl,
        credentials.authToken,
      );

      if (dryRun) {
        summary.previewed += 1;
        summary.details.push({
          replicaId,
          appId: linked.appId,
          alias: preview.alias,
          dbPath: linked.dbPath,
          status: "preview",
          preview,
        });
        continue;
      }

      if (options.shipUnsatisfied && preview.unsatisfied.length > 0) {
        const shipped = await shipSchemaMigrationForDbPath(
          linked,
          linked.dbPath,
          preview.unsatisfied,
          apiKey,
        );
        if (shipped > 0) {
          const waitMs = options.waitAfterShipMs ?? 15_000;
          if (waitMs > 0) {
            await waitForRemoteSchemaApplied(
              credentials.tursoUrl,
              credentials.authToken,
              migrationRoot,
              preview.unsatisfied,
              waitMs,
            );
          }
        }
      }

      const result = await alignMigrationLedgers(
        remote,
        linked.dbPath,
        migrationRoot,
      );

      summary.applied += 1;
      summary.details.push({
        replicaId,
        appId: linked.appId,
        alias: preview.alias,
        dbPath: linked.dbPath,
        status: "applied",
        preview,
        remoteBackfilled: result.remoteBackfilled,
        localHydrated: result.localHydrated,
        localInferred: result.localInferred,
      });
    } catch (error) {
      summary.failed += 1;
      summary.details.push({
        replicaId,
        appId: linked.appId,
        alias: linked.alias ?? linked.jobId ?? replicaId,
        dbPath: linked.dbPath,
        status: "failed",
        error: (error as Error).message.slice(0, 200),
      });
    } finally {
      remote.close();
    }
  }

  return summary;
}

export function formatMigrationLedgerBackfillSummary(
  summary: MigrationLedgerBackfillSummary,
): string {
  const lines: string[] = [
    `[MigrationLedgerBackfill] dryRun=${summary.dryRun} attempted=${summary.attempted} applied=${summary.applied} previewed=${summary.previewed} skipped=${summary.skipped} failed=${summary.failed}`,
  ];

  for (const detail of summary.details) {
    const preview = detail.preview;
    if (!preview) {
      lines.push(
        `  ${detail.status} ${detail.replicaId} ${detail.alias} — ${detail.error ?? "no preview"}`,
      );
      continue;
    }

    lines.push(
      `  ${detail.status} ${detail.replicaId} app=${detail.appId.slice(0, 8)}… alias=${detail.alias}`,
    );
    lines.push(
      `    tables local=${preview.localTableCount} remote=${preview.remoteTableCount} remoteLedger=${preview.remoteLedgerCount}`,
    );
    lines.push(`    db: ${detail.dbPath}`);
    lines.push(`    migrations: ${path.basename(preview.migrationRoot)}`);

    if (preview.alreadyLedgered.length > 0) {
      lines.push(`    already ledgered: ${preview.alreadyLedgered.join(", ")}`);
    }
    if (preview.wouldBackfill.length > 0) {
      lines.push(
        `    ${summary.dryRun ? "would backfill" : "backfilled"}: ${preview.wouldBackfill.join(", ")}`,
      );
    }
    if (detail.remoteBackfilled && detail.remoteBackfilled.length > 0) {
      lines.push(`    remoteBackfilled: ${detail.remoteBackfilled.join(", ")}`);
    }
    if (detail.localHydrated && detail.localHydrated.length > 0) {
      lines.push(`    localHydrated: ${detail.localHydrated.join(", ")}`);
    }
    if (detail.localInferred && detail.localInferred.length > 0) {
      lines.push(`    localInferred: ${detail.localInferred.join(", ")}`);
    }
    if (preview.unsatisfied.length > 0) {
      lines.push(
        `    unsatisfied (needs workspace log ship): ${preview.unsatisfied.join(", ")}`,
      );
    }
    if (preview.skippedMarkers.length > 0) {
      lines.push(`    skipped markers: ${preview.skippedMarkers.join(", ")}`);
    }
    if (detail.error) {
      lines.push(`    error: ${detail.error}`);
    }
  }

  return lines.join("\n");
}

export const DEFAULT_JOE_COFFEE = {
  appId: JOE_COFFEE_APP_ID,
  replicaId: JOE_COFFEE_REPLICA_ID,
} as const;
