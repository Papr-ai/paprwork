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
  queryBatchLinkedDbViaTursoReplica,
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
import {
  isReplicaMissingColumnError,
  isReplicaSchemaDriftError,
} from "../tursoReplica/tursoReplicaSchemaDriftHeal.js";
import {
  awaitReplicaSchemaDriftHeal,
  scheduleReplicaSchemaDriftHeal,
} from "../tursoReplica/tursoReplicaSchemaDriftScheduler.js";
import { getTursoReplicaService } from "../tursoReplica/TursoReplicaService.js";
import {
  clearReplicaReadPathDegraded,
  isReplicaReadPathDegraded,
} from "../tursoReplica/tursoReplicaBackgroundRecovery.js";
import { isReplicaPathPublishQuiesced } from "../tursoReplica/tursoReplicaPublishQuiesce.js";
import { isTursoReplicaOnline } from "../../utils/tursoReplicaEnabled.js";
import { shouldMiniAppUseReplicaOnlyForReads } from "./miniAppInteractiveLoadWindow.js";
import { timeReplicaReadPhase } from "../tursoReplica/replicaReadPhaseTrace.js";

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
function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Mini-app UI reads must not block on cloud pull or a stuck sync queue. */
const REPLICA_MINI_APP_READ_TIMEOUT_MS = readEnvMs(
  "REPLICA_MINI_APP_READ_TIMEOUT_MS",
  5_000,
);
const REPLICA_MINI_APP_READ_RETRY_TIMEOUT_MS = readEnvMs(
  "REPLICA_MINI_APP_READ_RETRY_TIMEOUT_MS",
  15_000,
);
/** When degraded, still prefer local replica before cloud (worker wedge ≠ cloud is faster). */
const REPLICA_DEGRADED_LOCAL_READ_TIMEOUT_MS = readEnvMs(
  "REPLICA_DEGRADED_LOCAL_READ_TIMEOUT_MS",
  5_000,
);

export function isReplicaMiniAppReadTimeoutError(message: string): boolean {
  return /timed out after \d+ms/i.test(message);
}

/** First fulfilled promise wins; reject only when every path fails. */
export async function raceFirstSuccessful<T>(
  paths: Array<{ label: string; run: () => Promise<T> }>,
): Promise<{ value: T; label: string }> {
  if (paths.length === 0) {
    throw new Error("raceFirstSuccessful: no paths");
  }
  return new Promise((resolve, reject) => {
    let failures = 0;
    const errors: unknown[] = [];
    for (const { label, run } of paths) {
      void run().then(
        (value) => resolve({ value, label }),
        (err: unknown) => {
          errors.push(err);
          failures += 1;
          if (failures === paths.length) {
            const first = errors[0];
            reject(
              first instanceof Error
                ? first
                : new Error(String(first ?? "All read paths failed")),
            );
          }
        },
      );
    }
  });
}

function withMiniAppReplicaReadTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number = REPLICA_MINI_APP_READ_TIMEOUT_MS,
): Promise<T> {
  return timeReplicaReadPhase("replicaReadAttemptMs", () =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
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
    }),
  );
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
    const started = performance.now();
    let result: RoutedQueryResult;
    if (shouldUseTursoReplicaForSource(source)) {
      result = await this.queryReplicaSource(appId, source, sql, params);
    } else if (isLocalDbReadable(source.dbPath)) {
      const local = await this.pool.query(appId, source.dbPath, sql, params);
      result = { ...local, backend: "local" };
    } else {
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

      const remote = await this.queryViaTursoPrimary(
        appId,
        source,
        sql,
        params,
        client,
      );
      if (!remote) {
        throw new Error("Turso fallback query returned no result");
      }
      result = remote;
    }

    const elapsedMs = Math.round(performance.now() - started);
    if (elapsedMs >= 250) {
      console.log(
        `[DbRouter] Slow query ${elapsedMs}ms app=${appId} source=${source.alias ?? source.dbId} backend=${result.backend} rows=${result.count}`,
      );
    }
    return result;
  }

  /**
   * Run multiple SELECTs against one replica source in a single sync-worker queue slot.
   */
  async queryReplicaBatch(
    appId: string,
    source: AppDataSource,
    statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
  ): Promise<RoutedQueryResult[]> {
    if (statements.length === 0) {
      return [];
    }
    const dbPath = source.dbPath;
    if (dbPath && isReplicaPathPublishQuiesced(dbPath)) {
      throw new Error(
        `Database sync in progress for ${source.alias ?? source.dbId}. Retry in a moment.`,
      );
    }

    const batch = await withMiniAppReplicaReadTimeout(
      queryBatchLinkedDbViaTursoReplica(source, statements, {
        pullBeforeRead: false,
      }),
      `replica read batch (${source.alias ?? source.dbId ?? "db"}, ${statements.length})`,
    );
    clearReplicaReadPathDegraded(source.dbPath);
    const totalRows = batch.reduce((sum, part) => sum + part.count, 0);
    console.log(
      `[DbRouter] Turso replica query batch app=${appId} source=${source.alias} ` +
        `statements=${statements.length} rows=${totalRows}`,
    );
    return batch.map((part) => ({ ...part, backend: "turso-replica" }));
  }

  private async queryReplicaSource(
    appId: string,
    source: AppDataSource,
    sql: string,
    params?: unknown[],
  ): Promise<RoutedQueryResult> {
    const dbPath = source.dbPath;
    const skipLocalReplica =
      (dbPath && isReplicaPathPublishQuiesced(dbPath)) ||
      (dbPath && isReplicaReadPathDegraded(dbPath));

    if (skipLocalReplica && isTursoReplicaOnline()) {
      const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
      if (remote) {
        if (isReplicaPathPublishQuiesced(dbPath ?? "")) {
          console.log(
            `[DbRouter] Publish quiesce — served ${source.alias ?? source.dbId} from Turso primary`,
          );
        } else {
          console.warn(
            `[DbRouter] Degraded replica — served ${source.alias ?? source.dbId} from Turso primary`,
          );
        }
        return remote;
      }
    }

    if (
      dbPath &&
      isReplicaReadPathDegraded(dbPath) &&
      !isReplicaPathPublishQuiesced(dbPath) &&
      isTursoReplicaOnline()
    ) {
      try {
        const local = await withMiniAppReplicaReadTimeout(
          queryLinkedDbViaTursoReplica(source, sql, params, {
            pullBeforeRead: false,
          }),
          `degraded replica read (${source.alias ?? source.dbId ?? "db"})`,
          REPLICA_DEGRADED_LOCAL_READ_TIMEOUT_MS,
        );
        clearReplicaReadPathDegraded(source.dbPath);
        console.log(
          `[DbRouter] Degraded path recovered locally app=${appId} source=${source.alias} rows=${local.count}`,
        );
        return { ...local, backend: "turso-replica" };
      } catch (localError) {
        console.warn(
          `[DbRouter] Degraded local replica failed for ${source.alias ?? source.dbId}: ` +
            `${(localError as Error).message.slice(0, 120)}`,
        );
      }
    }

    if (dbPath && isReplicaPathPublishQuiesced(dbPath)) {
      throw new Error(
        `Database sync in progress for ${source.alias ?? source.dbId}. Retry in a moment.`,
      );
    }

    try {
      const alias = source.alias ?? source.dbId ?? "db";
      const replicaOnlyLoad = shouldMiniAppUseReplicaOnlyForReads(appId);
      if (isTursoReplicaOnline() && !replicaOnlyLoad) {
        const { value, label } = await raceFirstSuccessful<RoutedQueryResult>([
          {
            label: "turso-replica",
            run: async () => {
              const local = await withMiniAppReplicaReadTimeout(
                queryLinkedDbViaTursoReplica(source, sql, params, {
                  pullBeforeRead: false,
                }),
                `replica read (${alias})`,
              );
              return { ...local, backend: "turso-replica" };
            },
          },
          {
            label: "turso",
            run: async () => {
              const remote = await this.queryViaTursoPrimary(
                appId,
                source,
                sql,
                params,
              );
              if (!remote) {
                throw new Error("Turso primary unavailable");
              }
              return remote;
            },
          },
        ]);
        clearReplicaReadPathDegraded(source.dbPath);
        console.log(
          `[DbRouter] Turso ${label} query app=${appId} source=${source.alias} rows=${value.count}`,
        );
        return value;
      }

      if (replicaOnlyLoad) {
        console.log(
          `[DbRouter] Mini-app load window — replica-only read app=${appId} source=${source.alias}`,
        );
      }

      const result = await withMiniAppReplicaReadTimeout(
        queryLinkedDbViaTursoReplica(source, sql, params, {
          pullBeforeRead: false,
        }),
        `replica read (${alias})`,
      );
      clearReplicaReadPathDegraded(source.dbPath);
      console.log(
        `[DbRouter] Turso replica query app=${appId} source=${source.alias} rows=${result.count}`,
      );
      return { ...result, backend: "turso-replica" };
    } catch (error) {
      const message = (error as Error).message;

      if (isReplicaSchemaDriftError(message)) {
        console.warn(
          `[DbRouter] Schema drift on replica for ${source.alias ?? source.dbId} — applying migrations on handle`,
        );
        try {
          await awaitReplicaSchemaDriftHeal(source);
          const healed = await queryLinkedDbViaTursoReplica(source, sql, params, {
            pullBeforeRead: false,
          });
          clearReplicaReadPathDegraded(source.dbPath);
          console.log(
            `[DbRouter] Turso replica query (post-heal) app=${appId} source=${source.alias} rows=${healed.count}`,
          );
          return { ...healed, backend: "turso-replica" };
        } catch (healError) {
          console.warn(
            `[DbRouter] Schema heal/retry failed for ${source.alias ?? source.dbId}: ` +
              `${(healError as Error).message.slice(0, 160)}`,
          );
          scheduleReplicaSchemaDriftHeal(source);
        }
        if (isTursoReplicaOnline()) {
          const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
          if (remote) {
            console.warn(
              `[DbRouter] Served ${source.alias ?? source.dbId} from Turso primary ` +
                "while local schema migrates in background",
            );
            return remote;
          }
        }
        throw new Error(
          `Schema update pending for ${source.alias ?? source.dbId}. ` +
            "Local replica is catching up — retry in a moment.",
        );
      }

      if (isReplicaSqlSchemaError(message) && !isReplicaSchemaDriftError(message)) {
        throw error;
      }

      if (isReplicaMissingColumnError(message) && isTursoReplicaOnline()) {
        console.warn(
          `[DbRouter] Missing column on replica for ${source.alias ?? source.dbId} — Turso primary fallback`,
        );
        const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
        if (remote) {
          return remote;
        }
      }

      if (isReplicaMiniAppReadTimeoutError(message)) {
        const allowPrimary = !shouldMiniAppUseReplicaOnlyForReads(appId);
        console.warn(
          `[DbRouter] Replica read slow for ${source.alias ?? source.dbId} — ` +
            (allowPrimary ? "Turso primary or local retry" : "local retry (load window)"),
        );
        if (allowPrimary && isTursoReplicaOnline()) {
          const remoteAfterTimeout = await this.queryViaTursoPrimary(
            appId,
            source,
            sql,
            params,
          );
          if (remoteAfterTimeout) {
            console.warn(
              `[DbRouter] Served ${source.alias ?? source.dbId} from Turso primary ` +
                "after local replica read timeout",
            );
            return remoteAfterTimeout;
          }
        }
        try {
          const retry = await withMiniAppReplicaReadTimeout(
            queryLinkedDbViaTursoReplica(source, sql, params, {
              pullBeforeRead: false,
            }),
            `replica read retry (${source.alias ?? source.dbId ?? "db"})`,
            REPLICA_MINI_APP_READ_RETRY_TIMEOUT_MS,
          );
          clearReplicaReadPathDegraded(source.dbPath);
          console.log(
            `[DbRouter] Turso replica query (retry) app=${appId} source=${source.alias} rows=${retry.count}`,
          );
          return { ...retry, backend: "turso-replica" };
        } catch (retryError) {
          if (allowPrimary && isTursoReplicaOnline()) {
            const remoteAfterRetry = await this.queryViaTursoPrimary(
              appId,
              source,
              sql,
              params,
            );
            if (remoteAfterRetry) {
              console.warn(
                `[DbRouter] Served ${source.alias ?? source.dbId} from Turso primary ` +
                  "after local replica retry timeout",
              );
              return remoteAfterRetry;
            }
          }
          throw new Error(
            `Replica read timed out for ${source.alias ?? source.dbId}. ` +
              "The local database worker was still busy — retry in a moment. " +
              `Original: ${(retryError as Error).message.slice(0, 120)}`,
          );
        }
      }

      const tursoDatabase = resolveTursoDatabaseName(source);

      if (tursoDatabase && isReplicaCheckpointWalError(message)) {
        if (source.dbPath && isReplicaPathPublishQuiesced(source.dbPath)) {
          const remote = await this.queryViaTursoPrimary(appId, source, sql, params);
          if (remote) {
            console.warn(
              `[DbRouter] Publish quiesce — WAL wedge on ${source.alias ?? source.dbId}, served from Turso primary`,
            );
            return remote;
          }
        }
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

    try {
      const result = await client.execute({
        sql,
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
    } catch (error) {
      console.warn(
        `[DbRouter] Turso primary query failed for ${source.alias ?? source.dbId}: ` +
          `${(error as Error).message.slice(0, 160)}`,
      );
      return null;
    }
  }

  async schema(
    dbPath: string,
    source: AppDataSource,
  ): Promise<RoutedSchemaResult> {
    if (shouldUseTursoReplicaForSource(source)) {
      if (isReplicaReadPathDegraded(source.dbPath) && isTursoReplicaOnline()) {
        try {
          const local = await withMiniAppReplicaReadTimeout(
            schemaLinkedDbViaTursoReplica(source),
            `degraded replica schema (${source.alias ?? source.dbId ?? "db"})`,
            REPLICA_DEGRADED_LOCAL_READ_TIMEOUT_MS,
          );
          clearReplicaReadPathDegraded(source.dbPath);
          return { ...local, backend: "turso-replica" };
        } catch {
          /* fall through to Turso primary schema */
        }

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
