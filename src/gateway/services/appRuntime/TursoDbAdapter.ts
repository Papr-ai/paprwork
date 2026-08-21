/**
 * Execute mini-app SQL against Turso (cloud mode).
 * Credentials are server-held only — never sent to browsers.
 * One Turso database per linked job source.
 */

import { capReadSql, capRows, MAX_READ_ROWS } from "./dbRequestGuard.js";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  bumpRemoteSyncVersion,
  filterSyncableTables,
  quoteIdent,
  readRemoteSyncVersion,
} from "../tursoSyncBridgeCore.js";
import {
  ensureRemoteSyncInfrastructure,
  ensureRemoteTableSyncTriggers,
} from "../tursoSyncLog.js";
import { jobTursoDatabaseName } from "../tursoDatabaseNaming.js";
import { shouldSkipMigrationForRemoteLedger } from "../jobs/migrationLedgerPolicy.js";
import {
  getDatabaseRegistryService,
  tursoNameForRecord,
} from "../DatabaseRegistryService.js";
import {
  resolveAppDataSource,
  type AppDataSource,
  type AppDataSourcesFile,
} from "../appDataSources.js";
import { seedPerUserSchemaFromBase } from "../tursoPerUserSchemaSeed.js";
import type {
  AppRuntimeRouteAuth,
  DbQueryResult,
  DbSchemaSource,
  DbWriteBatchResultItem,
  DbWriteBatchStatement,
  DbWriteResult,
  TursoCredentialsProvider,
} from "./types.js";
import { displayTableName, rewriteSqlForTurso } from "./rewriteSqlForTurso.js";

function toLibsqlArgs(params: unknown[] | undefined): InArgs {
  return (params ?? []) as InArgs;
}

/**
 * How often (per database) the adapter re-reads _papr_sync_meta to detect
 * writes from other writers (desktop boundary-sync pushes, sandboxes).
 * Bounds micro-cache staleness for external writes to roughly this window.
 */
const SYNC_VERSION_CHECK_MS = Number(
  process.env["CLOUD_DB_VERSION_CHECK_MS"] ?? 2_500,
);

interface SyncVersionMemo {
  version: number | null;
  checkedAt: number;
}

export class TursoDbAdapter {
  private clientCache = new Map<string, Client>();
  /** Last observed _papr_sync_meta version per client key. */
  private syncVersionMemo = new Map<string, SyncVersionMemo>();
  /** Remote changelog triggers installed per client key. */
  private remoteSyncReady = new Set<string>();

  constructor(private readonly credentials: TursoCredentialsProvider) {}

  private clientKey(
    runtimeAuth: AppRuntimeRouteAuth,
    userId: string,
    database: string,
  ): string {
    return `${runtimeAuth.namespaceId}:${runtimeAuth.slug}:${userId}:${database}`;
  }

  private async resolveTursoDatabaseName(
    source: AppDataSource,
    userId: string,
  ): Promise<string> {
    const registry = getDatabaseRegistryService();
    const record = registry.getRecordForSource(source);
    if (record) {
      return tursoNameForRecord(record, userId);
    }
    if (source.dbId) {
      // Fail closed: a dbId source without a registry record could be
      // per-user — falling back to a shared job/db name would silently leak
      // one user's data to everyone. Better a hard error than a quiet leak.
      throw new Error(
        `No registry record for dbId ${source.dbId} (source ${source.alias}) — ` +
          `refusing shared-name fallback; sync databases.json and retry`,
      );
    }
    if (source.jobId) {
      // Legacy job-owned source predating the registry — cannot be per-user.
      return jobTursoDatabaseName(source.jobId);
    }
    throw new Error(`Cannot resolve Turso database for source ${source.alias}`);
  }

  private async getClientForSource(
    orgId: string,
    namespaceId: string,
    userId: string,
    runtimeAuth: AppRuntimeRouteAuth,
    source: AppDataSource,
  ): Promise<Client> {
    const database = await this.resolveTursoDatabaseName(source, userId);
    const cacheKey = this.clientKey(runtimeAuth, userId, database);
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;

    const { tursoUrl, authToken } = await this.credentials.getUserDatabaseToken(
      orgId,
      namespaceId,
      userId,
      runtimeAuth,
      database,
    );
    const client = createClient({ url: tursoUrl, authToken });
    this.clientCache.set(cacheKey, client);

    const registry = getDatabaseRegistryService();
    const record = registry.getRecordForSource(source);
    if (record?.isolation === "per-user") {
      const baseName = tursoNameForRecord(record);
      if (baseName !== database) {
        try {
          const baseCreds = await this.credentials.getUserDatabaseToken(
            orgId,
            namespaceId,
            userId,
            runtimeAuth,
            baseName,
          );
          const baseClient = createClient({
            url: baseCreds.tursoUrl,
            authToken: baseCreds.authToken,
          });
          try {
            await seedPerUserSchemaFromBase(client, baseClient);
          } finally {
            baseClient.close();
          }
        } catch {
          // Best-effort — empty per-user DB is still valid
        }
      }
    }

    return client;
  }

  /**
   * Best-effort bump of the remote sync version after a host-side write so
   * desktop version-checked pulls see the change. Never fails the write.
   */
  private async bumpSyncVersionSafe(client: Client, key: string): Promise<void> {
    try {
      const version = await bumpRemoteSyncVersion(client);
      this.syncVersionMemo.set(key, {
        version: version ?? null,
        checkedAt: Date.now(),
      });
    } catch {
      // Best-effort — a failed bump only delays other devices' pulls until
      // the next successful push bumps the counter.
    }
  }

  /** Install remote CDC triggers so cloud mini-app writes appear in _papr_sync_log. */
  private async ensureRemoteChangeLogReady(
    client: Client,
    cacheKey: string,
  ): Promise<void> {
    if (this.remoteSyncReady.has(cacheKey)) {
      return;
    }
    await ensureRemoteSyncInfrastructure(client);
    const tableNames = await this.listRemoteTables(client);
    for (const tableName of tableNames) {
      const cols = await client.execute(
        `PRAGMA table_info(${quoteIdent(tableName)})`,
      );
      const columns = cols.rows.map((row) => ({
        name: String(row.name ?? ""),
        type: String(row.type ?? "TEXT"),
        primaryKey: Number(row.pk ?? 0) > 0,
      }));
      await ensureRemoteTableSyncTriggers(client, columns, tableName);
    }
    this.remoteSyncReady.add(cacheKey);
  }

  /**
   * True when another writer (e.g. a desktop boundary-sync push) has bumped
   * _papr_sync_meta since we last looked. Memoized per database for
   * SYNC_VERSION_CHECK_MS so cache-hit paths stay cheap (at most one
   * single-row read per window). Fail-open: errors report "unchanged".
   */
  async hasRemoteChanged(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    sourceId?: string;
  }): Promise<boolean> {
    try {
      const source = await resolveAppDataSource(input.config, {
        sourceId: input.sourceId,
        operation: "read",
      });
      if (!source) return false;
      const database = await this.resolveTursoDatabaseName(
        source,
        input.userId,
      );
      const key = this.clientKey(input.runtimeAuth, input.userId, database);
      const memo = this.syncVersionMemo.get(key);
      const now = Date.now();
      if (memo && now - memo.checkedAt < SYNC_VERSION_CHECK_MS) return false;

      const client = await this.getClientForSource(
        input.orgId,
        input.namespaceId,
        input.userId,
        input.runtimeAuth,
        source,
      );
      const version = await readRemoteSyncVersion(client);
      this.syncVersionMemo.set(key, { version, checkedAt: now });
      if (!memo) return false; // first observation — nothing to compare against
      return version !== memo.version;
    } catch {
      return false; // fail-open: serve cached rather than error or hammer Turso
    }
  }

  private async listRemoteTables(client: Client): Promise<string[]> {
    const result = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      args: [],
    });
    return filterSyncableTables(
      result.rows.map((row) => String(row.name ?? "")),
    );
  }

  async resolveSource(
    config: AppDataSourcesFile,
    options: {
      sourceId?: string;
      sql?: string;
      operation: "read" | "write";
      orgId: string;
      namespaceId: string;
      userId: string;
      runtimeAuth: AppRuntimeRouteAuth;
    },
  ): Promise<{ source: AppDataSource; remoteSql: string; localTables: string[] }> {
    const tableExists = async (_dbPath: string, table: string): Promise<boolean> => {
      for (const candidate of config.sources) {
        const client = await this.getClientForSource(
          options.orgId,
          options.namespaceId,
          options.userId,
          options.runtimeAuth,
          candidate,
        );
        const row = await client.execute({
          sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`,
          args: [table],
        });
        if (row.rows.length > 0) return true;
      }
      return false;
    };

    const source = await resolveAppDataSource(config, {
      sourceId: options.sourceId,
      sql: options.sql,
      operation: options.operation,
      tableExists,
    });

    const client = await this.getClientForSource(
      options.orgId,
      options.namespaceId,
      options.userId,
      options.runtimeAuth,
      source,
    );

    const remoteTables = await this.listRemoteTables(client);
    const localTables = remoteTables
      .map((name) => displayTableName(name, source.jobId ?? ""))
      .filter((name): name is string => name !== null);
    const syncable = filterSyncableTables(localTables.length ? localTables : source.tables);

    const remoteSql = options.sql
      ? rewriteSqlForTurso(options.sql, source, syncable)
      : "";

    return { source, remoteSql, localTables: syncable };
  }

  async query(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    sourceId?: string;
    sql: string;
    params?: unknown[];
  }): Promise<DbQueryResult> {
    const { source, remoteSql } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "read",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      userId: input.userId,
      runtimeAuth: input.runtimeAuth,
    });

    const client = await this.getClientForSource(
      input.orgId,
      input.namespaceId,
      input.userId,
      input.runtimeAuth,
      source,
    );
    // Row cap: outer LIMIT keeps a single unbounded SELECT from billing
    // an entire large table's rows on Turso.
    const result = await client.execute({
      sql: capReadSql(remoteSql),
      args: toLibsqlArgs(input.params),
    });
    const allRows = result.rows.map((row) => ({ ...row })) as Record<string, unknown>[];
    const { rows, truncated } = capRows(allRows, MAX_READ_ROWS);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    return {
      rows,
      columns,
      count: rows.length,
      source: source.alias,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async write(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    sourceId?: string;
    sql: string;
    params?: unknown[];
  }): Promise<DbWriteResult> {
    const { source, remoteSql } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "write",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      userId: input.userId,
      runtimeAuth: input.runtimeAuth,
    });

    const database = await this.resolveTursoDatabaseName(source, input.userId);
    const cacheKey = this.clientKey(input.runtimeAuth, input.userId, database);

    if (this.usesWorkspaceLogAuthority()) {
      const { appendRuntimeWorkspaceLogEntry } = await import(
        "./memoryRuntimeClient.js"
      );
      const appendResult = await appendRuntimeWorkspaceLogEntry(input.runtimeAuth, {
        replicaId: database,
        kind: "row",
        dbSourceId: source.alias ?? source.jobId,
        payload: {
          appId: input.appId,
          sql: remoteSql,
          params: input.params,
        },
      });
      this.syncVersionMemo.delete(cacheKey);

      if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
        console.log(
          `[TursoDbAdapter] write app=${input.appId} source=${source.alias} ` +
            `memoryLatencyMs=${appendResult.latencyMs} ` +
            `changes=${appendResult.changes ?? 1}`,
        );
      }

      return {
        changes: appendResult.changes ?? 1,
        lastInsertRowid: appendResult.lastInsertRowid ?? 0,
        source: source.alias,
      };
    }

    const client = await this.getClientForSource(
      input.orgId,
      input.namespaceId,
      input.userId,
      input.runtimeAuth,
      source,
    );

    await this.ensureRemoteChangeLogReady(client, cacheKey);
    const result = await client.execute({
      sql: remoteSql,
      args: toLibsqlArgs(input.params),
    });

    // Bump _papr_sync_meta so desktop version-checked pulls (and other host
    // instances' version-gated caches) see this write.
    await this.bumpSyncVersionSafe(
      client,
      cacheKey,
    );

    return {
      changes: result.rowsAffected,
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      source: source.alias,
    };
  }

  /** Max row writes per interactive batch (matches read batch cap). */
  static readonly MAX_WRITE_BATCH = 25;

  async writeBatch(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    statements: DbWriteBatchStatement[];
  }): Promise<{ results: DbWriteBatchResultItem[] }> {
    if (input.statements.length === 0) {
      throw new Error("Batch must include at least one statement");
    }
    if (input.statements.length > TursoDbAdapter.MAX_WRITE_BATCH) {
      throw new Error(
        `Batch limited to ${TursoDbAdapter.MAX_WRITE_BATCH} statements`,
      );
    }

    type ResolvedStmt = {
      index: number;
      source: AppDataSource;
      remoteSql: string;
      params?: unknown[];
      database: string;
    };

    const resolved: ResolvedStmt[] = [];
    for (let index = 0; index < input.statements.length; index++) {
      const stmt = input.statements[index];
      const { source, remoteSql } = await this.resolveSource(input.config, {
        sourceId: stmt.sourceId,
        sql: stmt.sql,
        operation: "write",
        orgId: input.orgId,
        namespaceId: input.namespaceId,
        userId: input.userId,
        runtimeAuth: input.runtimeAuth,
      });
      const database = await this.resolveTursoDatabaseName(source, input.userId);
      resolved.push({
        index,
        source,
        remoteSql,
        params: stmt.params,
        database,
      });
    }

    const results: DbWriteBatchResultItem[] = new Array(input.statements.length);

    if (this.usesWorkspaceLogAuthority()) {
      const groups = new Map<string, ResolvedStmt[]>();
      for (const item of resolved) {
        const group = groups.get(item.database) ?? [];
        group.push(item);
        groups.set(item.database, group);
      }

      const { appendRuntimeWorkspaceLogBatch } = await import(
        "./memoryRuntimeClient.js"
      );

      for (const [database, group] of groups) {
        const cacheKey = this.clientKey(
          input.runtimeAuth,
          input.userId,
          database,
        );
        try {
          const batchResult = await appendRuntimeWorkspaceLogBatch(
            input.runtimeAuth,
            {
              replicaId: database,
              entries: group.map((item) => ({
                kind: "row" as const,
                dbSourceId: item.source.alias ?? item.source.jobId,
                payload: {
                  appId: input.appId,
                  sql: item.remoteSql,
                  params: item.params,
                },
              })),
            },
          );
          this.syncVersionMemo.delete(cacheKey);

          if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
            console.log(
              `[TursoDbAdapter] writeBatch app=${input.appId} replica=${database} ` +
                `count=${batchResult.count} memoryLatencyMs=${batchResult.latencyMs}`,
            );
          }

          for (const item of group) {
            results[item.index] = {
              ok: true,
              changes: 1,
              lastInsertRowid: 0,
              source: item.source.alias,
            };
          }
        } catch (err) {
          const message = (err as Error).message;
          for (const item of group) {
            results[item.index] = {
              ok: false,
              changes: 0,
              lastInsertRowid: 0,
              source: item.source.alias,
              error: message,
            };
          }
        }
      }

      return { results };
    }

    for (const item of resolved) {
      try {
        const writeResult = await this.write({
          orgId: input.orgId,
          namespaceId: input.namespaceId,
          userId: input.userId,
          runtimeAuth: input.runtimeAuth,
          config: input.config,
          appId: input.appId,
          sourceId: input.statements[item.index].sourceId,
          sql: input.statements[item.index].sql,
          params: item.params,
        });
        results[item.index] = { ok: true, ...writeResult };
      } catch (err) {
        results[item.index] = {
          ok: false,
          changes: 0,
          lastInsertRowid: 0,
          source: item.source.alias,
          error: (err as Error).message,
        };
      }
    }

    return { results };
  }

  async exec(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
    appId: string;
    sourceId?: string;
    sql: string;
  }): Promise<{ ok: true; source: string }> {
    const { source } = await this.resolveSource(input.config, {
      sourceId: input.sourceId,
      sql: input.sql,
      operation: "write",
      orgId: input.orgId,
      namespaceId: input.namespaceId,
      userId: input.userId,
      runtimeAuth: input.runtimeAuth,
    });

    const client = await this.getClientForSource(
      input.orgId,
      input.namespaceId,
      input.userId,
      input.runtimeAuth,
      source,
    );
    const database = await this.resolveTursoDatabaseName(source, input.userId);
    const cacheKey = this.clientKey(input.runtimeAuth, input.userId, database);

    if (this.usesWorkspaceLogAuthority()) {
      const { appendRuntimeWorkspaceLogEntry } = await import(
        "./memoryRuntimeClient.js"
      );
      await appendRuntimeWorkspaceLogEntry(input.runtimeAuth, {
        replicaId: database,
        kind: "schema",
        dbSourceId: source.alias ?? source.jobId,
        payload: {
          appId: input.appId,
          sql: input.sql,
        },
      });
      this.syncVersionMemo.delete(cacheKey);
      return { ok: true, source: source.alias };
    }

    await this.ensureRemoteChangeLogReady(client, cacheKey);
    await client.execute(input.sql);
    await this.bumpSyncVersionSafe(client, cacheKey);
    return { ok: true, source: source.alias };
  }

  private usesWorkspaceLogAuthority(): boolean {
    return Boolean(process.env.PAPR_CLOUD_APP_HOST_KEY?.trim());
  }

  async schema(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
  }): Promise<DbSchemaSource[]> {
    return Promise.all(
      input.config.sources.map(async (source) => {
        try {
          const client = await this.getClientForSource(
            input.orgId,
            input.namespaceId,
            input.userId,
            input.runtimeAuth,
            source,
          );
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
                columns: cols.rows.map((c) => ({
                  name: String(c.name ?? ""),
                  type: String(c.type ?? ""),
                  pk: Number(c.pk ?? 0) === 1,
                })),
              };
            }),
          );

          return {
            sourceId: source.id,
            alias: source.alias,
            tables,
          };
        } catch (err) {
          return {
            sourceId: source.id,
            alias: source.alias,
            tables: [],
            error: (err as Error).message,
          };
        }
      }),
    );
  }

  /** Highest applied migration id across all linked sources (for schema gate). */
  async getMaxAppliedMigrationId(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
  }): Promise<string | null> {
    let maxId: string | null = null;

    for (const source of input.config.sources) {
      try {
        const client = await this.getClientForSource(
          input.orgId,
          input.namespaceId,
          input.userId,
          input.runtimeAuth,
          source,
        );
        const result = await client.execute(
          "SELECT id FROM schema_migrations ORDER BY id",
        );
        for (const row of result.rows) {
          const id = String(row.id ?? "");
          if (!id || shouldSkipMigrationForRemoteLedger(id)) {
            continue;
          }
          if (!maxId || id > maxId) {
            maxId = id;
          }
        }
      } catch {
        /* skip source */
      }
    }

    return maxId;
  }

  /**
   * Best-effort prefetch of Turso db-token + libsql clients for linked sources.
   * Called async on app open so first read/write avoids cold-token latency.
   */
  async warmLinkedSources(input: {
    orgId: string;
    namespaceId: string;
    userId: string;
    runtimeAuth: AppRuntimeRouteAuth;
    config: AppDataSourcesFile;
  }): Promise<void> {
    for (const source of input.config.sources) {
      if (!source.jobId && !source.dbId) {
        continue;
      }
      try {
        await this.getClientForSource(
          input.orgId,
          input.namespaceId,
          input.userId,
          input.runtimeAuth,
          source,
        );
      } catch {
        /* best-effort warm */
      }
    }
  }
}

export { jobTursoDatabaseName };
