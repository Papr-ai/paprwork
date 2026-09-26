/**
 * Cloud-direct databases: no local file, every read / write / migration goes to
 * the Turso primary over HTTP (@libsql/client).
 *
 * Used for NEW databases on devices with no Turso Sync engine build (Intel Mac,
 * Windows ARM) when cloud sync is on. Before this existed those devices fell
 * back to a local better-sqlite3 file with a separate legacy sync path — the
 * path the LinkedIn Outreach fork broke on. Cloud-direct removes that second
 * engine for new databases: the primary is the only copy, so there is nothing
 * to drift and nothing to half-apply.
 *
 * Trade-off (accepted): needs network. Offline reads/writes fail with a clear
 * message instead of silently diverging.
 */

import { createClient, type Client, type InValue } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  resolveTursoDatabaseNameForSource,
  tursoNameForRecord,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";
import { isCloudDirectSyncMode } from "../../utils/tursoReplicaEnabled.js";

export interface CloudDirectQueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  count: number;
}

export interface CloudDirectWriteResult {
  changes: number;
  lastInsertRowid: number;
}

const clients = new Map<string, Client>();

/** Tests inject a client factory (e.g. file: URL) instead of fetching Turso creds. */
type ClientFactory = (tursoDatabase: string) => Promise<Client>;
let clientFactoryOverride: ClientFactory | null = null;

export function setCloudDirectClientFactoryForTests(
  factory: ClientFactory | null,
): void {
  clientFactoryOverride = factory;
  for (const client of clients.values()) {
    client.close();
  }
  clients.clear();
}

/** Drop a cached client (database deleted / credentials rotated). */
export function closeCloudDirectClient(tursoDatabase: string): void {
  const client = clients.get(tursoDatabase);
  if (client) {
    client.close();
    clients.delete(tursoDatabase);
  }
}

export function resolveCloudDirectRecord(
  source: Pick<AppDataSource, "dbId" | "dbPath">,
): DatabaseRecord | undefined {
  // This check sits on every read/write hot path. A registry that cannot answer
  // (not initialised yet, or a partial stub) means "not cloud-direct" — the
  // existing replica/local routing then decides, exactly as before this mode.
  let record: DatabaseRecord | undefined;
  try {
    const registry = getDatabaseRegistryService();
    record =
      (source.dbId ? registry.getById?.(source.dbId) : undefined) ??
      (source.dbPath ? registry.getByPath?.(source.dbPath) : undefined);
  } catch {
    return undefined;
  }
  return record && isCloudDirectSyncMode(record.syncMode) ? record : undefined;
}

/** True when this linked source is a cloud-direct registry database. */
export function isCloudDirectSource(
  source: Pick<AppDataSource, "dbId" | "dbPath">,
): boolean {
  return resolveCloudDirectRecord(source) !== undefined;
}

export function isCloudDirectDbPath(dbPath: string): boolean {
  return isCloudDirectSource({ dbPath });
}

async function openClient(tursoDatabase: string): Promise<Client> {
  const cached = clients.get(tursoDatabase);
  if (cached) {
    return cached;
  }
  let client: Client;
  if (clientFactoryOverride) {
    client = await clientFactoryOverride(tursoDatabase);
  } else {
    const { ensureTursoSyncBridge } = await import("../TursoSyncBridge.js");
    const bridge = ensureTursoSyncBridge();
    if (!bridge.enabled) {
      throw cloudDirectUnavailable(
        tursoDatabase,
        "cloud sync is off or you are signed out",
      );
    }
    let creds;
    try {
      creds = await bridge.fetchCredentials(tursoDatabase);
    } catch (error) {
      throw cloudDirectUnavailable(tursoDatabase, (error as Error).message);
    }
    client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  }
  clients.set(tursoDatabase, client);
  return client;
}

function cloudDirectUnavailable(tursoDatabase: string, why: string): Error {
  return Object.assign(
    new Error(
      `This database lives in Papr Cloud (${tursoDatabase}) and could not be reached: ${why}. ` +
        "Check your connection and that you are signed in.",
    ),
    { status: 503 },
  );
}

function tursoDatabaseFor(source: Pick<AppDataSource, "dbId" | "dbPath" | "jobId">): string {
  const name = resolveTursoDatabaseNameForSource(source as AppDataSource);
  if (!name) {
    throw new Error(
      `No cloud database mapped for ${source.dbId ?? source.dbPath}`,
    );
  }
  return name;
}

/** Client for a cloud-direct source (shared with migrations and jobs). */
export async function cloudDirectClientForSource(
  source: Pick<AppDataSource, "dbId" | "dbPath" | "jobId">,
): Promise<Client> {
  return openClient(tursoDatabaseFor(source));
}

export async function cloudDirectClientForRecord(
  record: DatabaseRecord,
): Promise<Client> {
  return openClient(tursoNameForRecord(record));
}

function args(params?: unknown[]): InValue[] {
  return (params ?? []).map((value) =>
    value === undefined ? null : (value as InValue),
  );
}

export async function cloudDirectQuery(
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): Promise<CloudDirectQueryResult> {
  const client = await cloudDirectClientForSource(source);
  const result = await client.execute({ sql, args: args(params) });
  const rows = result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of result.columns) {
      out[column] = (row as Record<string, unknown>)[column];
    }
    return out;
  });
  return { rows, columns: [...result.columns], count: rows.length };
}

export async function cloudDirectWrite(
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): Promise<CloudDirectWriteResult> {
  const client = await cloudDirectClientForSource(source);
  const result = await client.execute({ sql, args: args(params) });
  return {
    changes: result.rowsAffected,
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

/** All-or-nothing: libsql batch runs in one write transaction. */
export async function cloudDirectWriteBatch(
  source: AppDataSource,
  statements: ReadonlyArray<{ sql: string; params?: unknown[] }>,
): Promise<CloudDirectWriteResult[]> {
  const client = await cloudDirectClientForSource(source);
  const results = await client.batch(
    statements.map((stmt) => ({ sql: stmt.sql, args: args(stmt.params) })),
    "write",
  );
  return results.map((result) => ({
    changes: result.rowsAffected,
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  }));
}

export async function cloudDirectExec(
  source: AppDataSource,
  sql: string,
): Promise<void> {
  const client = await cloudDirectClientForSource(source);
  await client.executeMultiple(sql);
}

export async function cloudDirectTableExists(
  source: AppDataSource,
  table: string,
): Promise<boolean> {
  const result = await cloudDirectQuery(
    source,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    [table],
  );
  return result.count > 0;
}
