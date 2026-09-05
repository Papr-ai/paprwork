/**
 * Routes mini-app DB reads and writes.
 * Legacy / local-only: better-sqlite3 pool. Replica DBs: @tursodatabase/sync only (Plan A).
 */

import * as fs from "fs";
import { createClient, type Client } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";
import type {
  DbQueryPool,
  QueryResult,
  SchemaResult,
} from "../DbQueryPool.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import {
  filterSyncableTables,
  quoteIdent,
} from "../tursoSyncBridgeCore.js";
import { resolveTursoDatabaseNameForSource } from "../DatabaseRegistryService.js";
import {
  queryLinkedDbViaTursoReplica,
  recoverReplicaAfterCheckpointError,
  schemaLinkedDbViaTursoReplica,
  shouldUseTursoReplicaForSource,
  writeLinkedDbViaTursoReplica,
  writeLinkedDbBatchViaTursoReplica,
  execLinkedDbViaTursoReplica,
} from "../tursoReplica/tursoReplicaRouting.js";
import {
  isReplicaCheckpointWalError,
  isReplicaSqlSchemaError,
} from "../tursoReplica/tursoReplicaCheckpointRecovery.js";
import { getTursoReplicaService } from "../tursoReplica/TursoReplicaService.js";
import { isReplicaReadPathDegraded } from "../tursoReplica/tursoReplicaBackgroundRecovery.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { displayTableName, rewriteSqlForTurso } from "./rewriteSqlForTurso.js";

export type DbBackend = "local" | "turso" | "turso-replica";

export interface RoutedQueryResult extends QueryResult {
  backend: DbBackend;
}

export interface RoutedSchemaResult extends SchemaResult {
  backend: DbBackend;
}

const tursoClients = new Map<string, Client>();
const tursoClientPromises = new Map<string, Promise<Client | null>>();
const tursoUnavailableUntil = new Map<string, number>();
const TURSO_UNAVAILABLE_COOLDOWN_MS = 30_000;
/** Mini-app UI reads must not block on cloud pull or a stuck sync queue. */
const REPLICA_MINI_APP_READ_TIMEOUT_MS = 2_500;

function withMiniAppReplicaReadTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${REPLICA_MINI_APP_READ_TIMEOUT_MS}ms`,
        ),
      );
    }, REPLICA_MINI_APP_READ_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isLocalDbReadable(dbPath: string): boolean {
  try {
    return fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

function resolveTursoDatabaseName(source: AppDataSource): string | null {
  return resolveTursoDatabaseNameForSource(source);
}

async function getTursoClientForSource(
  source: AppDataSource,
): Promise<Client | null> {
  const databaseName = resolveTursoDatabaseName(source);
  if (!databaseName) {
    return null;
  }

  const unavailableUntil = tursoUnavailableUntil.get(databaseName);
  if (unavailableUntil != null && Date.now() < unavailableUntil) {
    return null;
  }

  const cached = tursoClients.get(databaseName);
  if (cached) {
    return cached;
  }

  const inFlight = tursoClientPromises.get(databaseName);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const bridge = getTursoSyncBridge();
    if (!bridge) {
      tursoUnavailableUntil.set(
        databaseName,
        Date.now() + TURSO_UNAVAILABLE_COOLDOWN_MS,
      );
      return null;
    }
    try {
      const credentials = await bridge.fetchCredentials(databaseName);
      tursoUnavailableUntil.delete(databaseName);
      const client = createClient({
        url: credentials.tursoUrl,
        authToken: credentials.authToken,
      });
      tursoClients.set(databaseName, client);
      return client;
    } catch (error) {
      tursoUnavailableUntil.set(
        databaseName,
        Date.now() + TURSO_UNAVAILABLE_COOLDOWN_MS,
      );
      console.warn(
        `[DbRouter] Turso fallback unavailable for ${databaseName}:`,
        (error as Error).message.slice(0, 120),
      );
      return null;
    } finally {
      tursoClientPromises.delete(databaseName);
    }
  })();

  tursoClientPromises.set(databaseName, promise);
  return promise;
}

async function listTursoLocalTables(source: AppDataSource): Promise<string[]> {
  const client = await getTursoClientForSource(source);
  if (!client) {
    return [];
  }

  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    args: [],
  });

  return filterSyncableTables(
    result.rows
      .map((row) =>
        displayTableName(String(row.name ?? ""), source.jobId ?? ""),
      )
      .filter((name): name is string => name !== null),
  );
}

export class DbRouter {
  constructor(private readonly pool: DbQueryPool) {}

  async tableExists(
    dbPath: string,
    table: string,
    source: AppDataSource,
  ): Promise<boolean> {
    if (shouldUseTursoReplicaForSource(source)) {
      const result = await queryLinkedDbViaTursoReplica(
        source,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        [table],
      );
      return result.count > 0;
    }

    if (isLocalDbReadable(dbPath)) {
      return this.pool.tableExists(dbPath, table);
    }

    const client = await getTursoClientForSource(source);
    if (!client) {
      return false;
    }

    const row = await client.execute({
      sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
      args: [table],
    });
    return row.rows.length > 0;
  }

  async query(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ): Promise<RoutedQueryResult> {
    if (shouldUseTursoReplicaForSource(source)) {
      return this.queryReplicaSource(appId, source, sql, params);
    }

    if (isLocalDbReadable(source.dbPath)) {
      const result = await this.pool.query(appId, source.dbPath, sql, params);
      return { ...result, backend: "local" };
    }

    const client = await getTursoClientForSource(source);
    if (!client) {
      const pathHint = source.dbPath?.trim()
        ? source.dbPath
        : source.dbId
          ? `(unresolved dbId ${source.dbId})`
          : "(no dbPath configured)";
      throw new Error(
        `Local database not found at ${pathHint} and Turso fallback is unavailable. ` +
          "Sign in to Papr or run the linked job on this machine first.",
      );
    }

    const remote = await this.queryViaTursoPrimary(appId, source, sql, params, client);
    if (!remote) {
      throw new Error("Turso fallback query returned no result");
    }
    return remote;
  }

  private async queryReplicaSource(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ): Promise<RoutedQueryResult> {
    if (isReplicaReadPathDegraded(source.dbPath) && isTursoReplicaOnline()) {
      const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
      if (remote) {
        console.warn(
          `[DbRouter] Degraded replica path — served ${source.alias ?? source.dbId} from Turso primary`,
        );
        return remote;
      }
    }

    try {
      const result = await withMiniAppReplicaReadTimeout(
        queryLinkedDbViaTursoReplica(source, sql, params, {
          pullBeforeRead: false,
        }),
        `replica read (${source.alias ?? source.dbId ?? "db"})`,
      );
      console.log(
        `[DbRouter] Turso replica query app=${appId} source=${source.alias} rows=${result.count}`,
      );
      return { ...result, backend: "turso-replica" };
    } catch (error) {
      const message = (error as Error).message;

      if (isReplicaSqlSchemaError(message)) {
        throw error;
      }

      const tursoDatabase = resolveTursoDatabaseName(source);

      if (tursoDatabase && isReplicaCheckpointWalError(message)) {
        console.warn(
          `[DbRouter] Replica checkpoint error for ${source.alias ?? source.dbId} — ` +
            "attempting Tier-1 recovery (pull + drain CDC)",
        );
        const recovered = await recoverReplicaAfterCheckpointError(
          source,
          tursoDatabase,
        );
        if (recovered) {
          try {
            const retry = await queryLinkedDbViaTursoReplica(
              source,
              sql,
              params,
              { pullBeforeRead: true },
            );
            console.log(
              `[DbRouter] Turso replica query (recovered) app=${appId} source=${source.alias} rows=${retry.count}`,
            );
            return { ...retry, backend: "turso-replica" };
          } catch (retryError) {
            console.warn(
              `[DbRouter] Replica retry after recovery failed:`,
              (retryError as Error).message.slice(0, 160),
            );
          }
        }
      }

      console.warn(
        `[DbRouter] Replica query failed for ${source.alias ?? source.dbId} — ` +
          `trying Turso primary fallback: ${message.slice(0, 160)}`,
      );
      await getTursoReplicaService().close(source.dbPath);
      if (isTursoReplicaOnline()) {
        const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
        if (remote) {
          return remote;
        }
        console.warn(
          `[DbRouter] Turso primary unavailable for ${source.alias ?? source.dbId}`,
        );
      }
      throw new Error(
        `Replica read failed for ${source.alias ?? source.dbId} and Turso primary is unavailable. ` +
          "Run Upload to recover replica sync, or retry after sync completes. " +
          `Original: ${message.slice(0, 200)}`,
      );
    }
  }

  private async queryViaTursoPrimary(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
    existingClient?: Client | null,
  ): Promise<RoutedQueryResult | null> {
    const client = existingClient ?? (await getTursoClientForSource(source));
    if (!client) {
      return null;
    }

    const remoteTables = await listTursoLocalTables(source);
    const syncable = filterSyncableTables(
      remoteTables.length > 0 ? remoteTables : source.tables,
    );
    const remoteSql = rewriteSqlForTurso(sql, source, syncable);
    const result = await client.execute({
      sql: remoteSql,
      args: (params ?? []) as (string | number | bigint | boolean | null)[],
    });

    const rows = result.rows.map((row) => ({ ...row })) as Record<
      string,
      unknown
    >[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    console.log(
      `[DbRouter] Turso primary query app=${appId} source=${source.alias ?? source.jobId} rows=${rows.length}`,
    );

    return {
      rows,
      columns,
      count: rows.length,
      backend: "turso",
    };
  }

  async schema(
    dbPath: string,
    source: AppDataSource,
  ): Promise<RoutedSchemaResult> {
    if (shouldUseTursoReplicaForSource(source)) {
      if (isReplicaReadPathDegraded(source.dbPath) && isTursoReplicaOnline()) {
        const client = await getTursoClientForSource(source);
        if (client) {
          const tablesResult = await client.execute({
            sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
            args: [],
          });
          const tables = await Promise.all(
            filterSyncableTables(
              tablesResult.rows.map((row) => String(row.name ?? "")),
            ).map(async (localName) => {
              const cols = await client.execute(
                `PRAGMA table_info(${quoteIdent(localName)})`,
              );
              return {
                table: localName,
                columns: cols.rows.map((column) => ({
                  name: String(column.name ?? ""),
                  type: String(column.type ?? ""),
                  pk: Number(column.pk ?? 0) === 1,
                })),
              };
            }),
          );
          return { tables, backend: "turso" };
        }
      }

      try {
        const result = await schemaLinkedDbViaTursoReplica(source);
        return { ...result, backend: "turso-replica" };
      } catch (error) {
        const message = (error as Error).message;

        const tursoDatabase = resolveTursoDatabaseName(source);

        if (tursoDatabase && isReplicaCheckpointWalError(message)) {
          const recovered = await recoverReplicaAfterCheckpointError(
            source,
            tursoDatabase,
          );
          if (recovered) {
            try {
              const retry = await schemaLinkedDbViaTursoReplica(source);
              return { ...retry, backend: "turso-replica" };
            } catch {
              /* fall through to primary / error */
            }
          }
        }

        console.warn(
          `[DbRouter] Replica schema failed for ${source.alias ?? source.dbId}:`,
          message.slice(0, 160),
        );
        await getTursoReplicaService().close(source.dbPath);

        if (isTursoReplicaOnline()) {
          const client = await getTursoClientForSource(source);
          if (client) {
            const tablesResult = await client.execute({
              sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
              args: [],
            });
            const tables = await Promise.all(
              filterSyncableTables(
                tablesResult.rows.map((row) => String(row.name ?? "")),
              ).map(async (localName) => {
                const cols = await client.execute(
                  `PRAGMA table_info(${quoteIdent(localName)})`,
                );
                return {
                  table: localName,
                  columns: cols.rows.map((column) => ({
                    name: String(column.name ?? ""),
                    type: String(column.type ?? ""),
                    pk: Number(column.pk ?? 0) === 1,
                  })),
                };
              }),
            );
            return { tables, backend: "turso" };
          }
        }

        throw new Error(
          `Replica schema read failed for ${source.alias ?? source.dbId}. ` +
            `Run Upload to recover. Original: ${message.slice(0, 200)}`,
        );
      }
    }

    if (isLocalDbReadable(dbPath)) {
      const result = await this.pool.schema(dbPath);
      return { ...result, backend: "local" };
    }

    const client = await getTursoClientForSource(source);
    if (!client) {
      throw new Error(
        `Local database not found at ${dbPath} and Turso fallback is unavailable.`,
      );
    }

    const tablesResult = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      args: [],
    });

    const tables = await Promise.all(
      filterSyncableTables(
        tablesResult.rows.map((row) => String(row.name ?? "")),
      ).map(async (localName) => {
        const cols = await client.execute(
          `PRAGMA table_info(${quoteIdent(localName)})`,
        );
        return {
          table: localName,
          columns: cols.rows.map((column) => ({
            name: String(column.name ?? ""),
            type: String(column.type ?? ""),
            pk: Number(column.pk ?? 0) === 1,
          })),
        };
      }),
    );

    return {
      tables,
      backend: "turso",
    };
  }

  async write(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ): Promise<import("../DbQueryPool.js").WriteResult> {
    if (shouldUseTursoReplicaForSource(source)) {
      const result = await writeLinkedDbViaTursoReplica(source, sql, params);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    }
    if (!isLocalDbReadable(source.dbPath)) {
      throw Object.assign(
        new Error(
          `Cannot write: local database missing at ${source.dbPath}. ` +
            "Run the linked job on this device or restore from Turso pull first.",
        ),
        { status: 503 },
      );
    }
    return this.pool.write(appId, source.dbPath, sql, params);
  }

  async writeBatch(
    appId: string,
    source: AppDataSource,
    statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
  ): Promise<import("../DbQueryPool.js").WriteResult[]> {
    if (shouldUseTursoReplicaForSource(source)) {
      const result = await writeLinkedDbBatchViaTursoReplica(source, statements);
      return [
        {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        },
      ];
    }
    if (!isLocalDbReadable(source.dbPath)) {
      throw Object.assign(
        new Error(
          `Cannot write: local database missing at ${source.dbPath}. ` +
            "Run the linked job on this device or restore from Turso pull first.",
        ),
        { status: 503 },
      );
    }
    return this.pool.writeBatch(appId, source.dbPath, [...statements]);
  }

  async exec(appId: string, source: AppDataSource, sql: string): Promise<void> {
    if (shouldUseTursoReplicaForSource(source)) {
      await execLinkedDbViaTursoReplica(source, sql);
      return;
    }
    if (!isLocalDbReadable(source.dbPath)) {
      throw Object.assign(
        new Error(
          `Cannot exec: local database missing at ${source.dbPath}. ` +
            "Run the linked job on this device first.",
        ),
        { status: 503 },
      );
    }
    return this.pool.exec(appId, source.dbPath, sql);
  }
}

let routerInstance: DbRouter | null = null;

export function initializeDbRouter(pool: DbQueryPool): DbRouter {
  routerInstance = new DbRouter(pool);
  return routerInstance;
}

export function getDbRouter(): DbRouter {
  if (!routerInstance) {
    throw new Error("[DbRouter] Not initialized — call initializeDbRouter() first");
  }
  return routerInstance;
}

/** Reset cached Turso clients (tests). */
export function resetDbRouterTursoCache(): void {
  tursoClients.clear();
  tursoClientPromises.clear();
}
