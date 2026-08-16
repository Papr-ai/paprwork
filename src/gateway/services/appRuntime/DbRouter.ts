/**
 * Routes mini-app DB reads: local SQLite first, Turso fallback when data.db is missing.
 * Writes always use local SQLite (cloud replica is updated via TursoSyncBridge push).
 * One Turso database per linked job.
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
import { displayTableName, rewriteSqlForTurso } from "./rewriteSqlForTurso.js";

export type DbBackend = "local" | "turso";

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
      `[DbRouter] Turso fallback query app=${appId} job=${source.jobId} rows=${rows.length}`,
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

  async exec(appId: string, source: AppDataSource, sql: string): Promise<void> {
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
