/**
 * Plan A — Turso Sync replica connections (one open Database per local db path).
 */

import * as fs from "fs";
import * as path from "path";
import type { Database } from "@tursodatabase/sync";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import {
  connectTursoReplica,
  isTursoHostNotReadyError,
} from "./tursoReplicaConnect.js";
import type {
  TursoReplicaPushResponse,
  TursoReplicaSyncStatus,
  TursoReplicaWriteResult,
  DatabaseSyncMode,
  TursoReplicaDatabaseStats,
} from "./tursoReplicaTypes.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import {
  markTursoReplicaReachable,
  noteTursoReplicaTransportError,
} from "../../utils/tursoReplicaConnectivity.js";
import { MIGRATION_CONFLICT_CODE } from "./tursoReplicaMigrationConflict.js";
import { drainInboundReplicaCdcIfCaughtUp } from "./tursoReplicaInboundDrain.js";
import type { AppDataSource } from "../appDataSources.js";

const REPLICA_STATUS_OPEN_TIMEOUT_MS = 12_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
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

interface OpenReplicaHandle {
  db: Database;
  tursoDatabase: string;
  localPath: string;
}

interface RunWriteParams {
  localPath: string;
  tursoDatabase: string;
  sql: string;
  params?: unknown[];
}

function normalizeReplicaRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return { ...(row as Record<string, unknown>) };
    }
    if (Array.isArray(row)) {
      return { value: row[0] };
    }
    return { value: row };
  });
}

function normalizeDbPath(dbPath: string): string {
  return path.normalize(dbPath);
}

function extractWriteMetrics(runResult: unknown): {
  changes: number;
  lastInsertRowid: number;
} {
  if (runResult && typeof runResult === "object") {
    const row = runResult as Record<string, unknown>;
    const changes =
      typeof row.changes === "number"
        ? row.changes
        : typeof row.rowsAffected === "number"
          ? row.rowsAffected
          : 0;
    const lastInsertRowid =
      typeof row.lastInsertRowid === "number"
        ? row.lastInsertRowid
        : typeof row.lastInsertRowid === "bigint"
          ? Number(row.lastInsertRowid)
          : 0;
    return { changes, lastInsertRowid };
  }
  return { changes: 0, lastInsertRowid: 0 };
}

function formatReplicaPushError(message: string): string {
  if (message.includes("target_pull_gen > source_pull_gen")) {
    return (
      "REPLICA_GEN_DRIFT: Remote Turso is ahead of local replica — pull before push. " +
      message
    );
  }
  return message;
}

export class TursoReplicaService {
  private readonly openByPath = new Map<string, OpenReplicaHandle>();
  private readonly connectPromises = new Map<string, Promise<OpenReplicaHandle>>();
  private readonly operationChains = new Map<string, Promise<unknown>>();

  async runWrite(params: RunWriteParams): Promise<TursoReplicaWriteResult> {
    return this.runStatements({
      localPath: params.localPath,
      tursoDatabase: params.tursoDatabase,
      statements: [{ sql: params.sql, params: params.params }],
    });
  }

  async runStatements(options: {
    localPath: string;
    tursoDatabase: string;
    statements: ReadonlyArray<{ sql: string; params?: unknown[] }>;
  }): Promise<TursoReplicaWriteResult> {
    return this.withSerializedPath(options.localPath, async () => {
      const online = isTursoReplicaOnline();
      const handle = await this.getOrOpen({
        localPath: options.localPath,
        tursoDatabase: options.tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(options.localPath),
      });

      let lastMetrics = { changes: 0, lastInsertRowid: 0 };
      for (const statement of options.statements) {
        const stmt = await handle.db.prepare(statement.sql);
        const runResult = await stmt.run(...(statement.params ?? []));
        lastMetrics = extractWriteMetrics(runResult);
      }

      let pendingPush = false;
      if (online) {
        try {
          await this.pullAndPushReplica(handle);
        } catch (error) {
          noteTursoReplicaTransportError(error);
          throw new Error(
            `Turso replica push failed: ${(error as Error).message}`,
          );
        }
      } else {
        pendingPush = true;
      }

      return {
        changes: lastMetrics.changes,
        lastInsertRowid: lastMetrics.lastInsertRowid,
        pendingPush,
        backend: "turso-replica",
      };
    });
  }

  async runExec(
    localPath: string,
    tursoDatabase: string,
    sql: string,
  ): Promise<{ pendingPush: boolean }> {
    return this.withSerializedPath(localPath, async () => {
      const online = isTursoReplicaOnline();
      const handle = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });

      await handle.db.exec(sql);

      let pendingPush = false;
      if (online) {
        try {
          await this.pullAndPushReplica(handle);
        } catch (error) {
          noteTursoReplicaTransportError(error);
          throw new Error(
            `Turso replica push failed: ${(error as Error).message}`,
          );
        }
      } else {
        pendingPush = true;
      }

      return { pendingPush };
    });
  }

  async push(
    localPath: string,
    tursoDatabase: string,
    options?: { pullBeforePush?: boolean },
  ): Promise<TursoReplicaPushResponse> {
    try {
      await this.withSerializedPath(localPath, async () => {
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(localPath),
        });
        if (isTursoReplicaOnline()) {
          if (options?.pullBeforePush === false) {
            await handle.db.push();
            markTursoReplicaReachable();
            const dbWithCheckpoint = handle.db as Database & {
              checkpoint?: () => Promise<void>;
            };
            if (typeof dbWithCheckpoint.checkpoint === "function") {
              await dbWithCheckpoint.checkpoint();
            }
          } else {
            await this.pullAndPushReplica(handle);
          }
        }
      });
      return { ok: true };
    } catch (error) {
      noteTursoReplicaTransportError(error);
      return { ok: false, error: formatReplicaPushError((error as Error).message) };
    }
  }

  async pull(localPath: string, tursoDatabase: string): Promise<boolean> {
    return this.withSerializedPath(localPath, async () => {
      const handle = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });
      return handle.db.pull().then((pulled) => {
        markTursoReplicaReachable();
        return pulled;
      });
    });
  }

  async readCdcOperations(
    localPath: string,
    tursoDatabase: string,
  ): Promise<number> {
    if (!isTursoReplicaSyncFeatureEnabled() || !fs.existsSync(localPath)) {
      return 0;
    }
    try {
      return await this.withSerializedPath(localPath, async () => {
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: false,
        });
        const stats = await handle.db.stats();
        return stats && typeof stats === "object" && "cdcOperations" in stats
          ? Number((stats as TursoReplicaDatabaseStats).cdcOperations)
          : 0;
      });
    } catch {
      return 0;
    }
  }

  async checkpoint(localPath: string, tursoDatabase: string): Promise<void> {
    await this.withSerializedPath(localPath, async () => {
      const handle = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });
      const dbWithCheckpoint = handle.db as Database & {
        checkpoint?: () => Promise<void>;
      };
      if (typeof dbWithCheckpoint.checkpoint === "function") {
        await dbWithCheckpoint.checkpoint();
      }
    });
  }

  async runQuery(options: {
    localPath: string;
    tursoDatabase: string;
    sql: string;
    params?: unknown[];
    pullBeforeRead?: boolean;
  }): Promise<import("../DbQueryPool.js").QueryResult> {
    return this.withSerializedPath(options.localPath, async () => {
      const handle = await this.getOrOpen({
        localPath: options.localPath,
        tursoDatabase: options.tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(options.localPath),
      });

      if (isTursoReplicaOnline() && options.pullBeforeRead !== false) {
        await handle.db.pull();
      }

      const stmt = await handle.db.prepare(options.sql);
      const rawRows = await stmt.all(...(options.params ?? []));
      const rows = normalizeReplicaRows(
        Array.isArray(rawRows) ? rawRows : [],
      );
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        rows,
        columns,
        count: rows.length,
      };
    });
  }

  async runSchema(
    localPath: string,
    tursoDatabase: string,
  ): Promise<import("../DbQueryPool.js").SchemaResult> {
    return this.withSerializedPath(localPath, async () => {
      const handle = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });

      if (isTursoReplicaOnline()) {
        await handle.db.pull();
      }

      const listStmt = await handle.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const tableRows = await listStmt.all();
      const tableNames = normalizeReplicaRows(
        Array.isArray(tableRows) ? tableRows : [],
      )
        .map((row) => String(row.name ?? ""))
        .filter((name) => name.length > 0);

      const tables: import("../DbQueryPool.js").SchemaTable[] = [];
      for (const tableName of tableNames) {
        const infoStmt = await handle.db.prepare(
          `PRAGMA table_info(${quoteIdent(tableName)})`,
        );
        const colRows = await infoStmt.all();
        const columns = normalizeReplicaRows(
          Array.isArray(colRows) ? colRows : [],
        ).map((column) => ({
          name: String(column.name ?? ""),
          type: String(column.type ?? ""),
          pk: Number(column.pk ?? 0) === 1,
        }));
        tables.push({ table: tableName, columns });
      }

      return { tables };
    });
  }

  async syncStatus(options: {
    localPath: string;
    tursoDatabase: string;
    syncMode?: DatabaseSyncMode;
    cutoverBlocked?: boolean;
    cutoverBlockReason?: string | null;
    lastPushError?: string | null;
    lastReplicaPushAt?: string | null;
    lastReplicaLocalMutationAt?: string | null;
    /** When set, attempt ledger-gated inbound CDC drain before reporting pending. */
    source?: AppDataSource;
  }): Promise<TursoReplicaSyncStatus> {
    const online = isTursoReplicaOnline();
    const syncMode = options.syncMode ?? "legacy";
    let stats = null;
    let pendingOps = 0;
    let handle: OpenReplicaHandle | null = null;

    if (isTursoReplicaSyncFeatureEnabled() && fs.existsSync(options.localPath)) {
      try {
        handle = await withTimeout(
          this.getOrOpen({
            localPath: options.localPath,
            tursoDatabase: options.tursoDatabase,
            bootstrapIfEmpty: false,
            syncOnOpen: false,
          }),
          REPLICA_STATUS_OPEN_TIMEOUT_MS,
          "replica sync status open",
        );
        stats = await handle.db.stats();
        pendingOps =
          stats && typeof stats === "object" && "cdcOperations" in stats
            ? Number((stats as TursoReplicaDatabaseStats).cdcOperations)
            : 0;
      } catch {
        /* status best-effort */
      }
    }

    const lastPushError = options.lastPushError ?? null;
    const migrationConflict =
      lastPushError?.startsWith(`${MIGRATION_CONFLICT_CODE}:`) ?? false;

    const pushAtMs = options.lastReplicaPushAt
      ? Date.parse(options.lastReplicaPushAt)
      : 0;
    const mutationAtMs = options.lastReplicaLocalMutationAt
      ? Date.parse(options.lastReplicaLocalMutationAt)
      : 0;
    const pushCoversLocalMutations =
      pushAtMs > 0 &&
      (mutationAtMs === 0 || pushAtMs >= mutationAtMs);

    let pendingPush = pendingOps > 0 || Boolean(lastPushError);
    if (
      pendingPush &&
      pendingOps > 0 &&
      !lastPushError &&
      !migrationConflict &&
      pushCoversLocalMutations
    ) {
      pendingPush = false;
    }

    return {
      online,
      syncMode,
      pendingPush,
      pendingOps,
      lastPushError,
      migrationConflict,
      cutoverBlocked: options.cutoverBlocked ?? false,
      cutoverBlockReason: options.cutoverBlockReason ?? null,
      stats,
    };
  }

  async close(localPath: string): Promise<void> {
    const key = normalizeDbPath(localPath);
    const handle = this.openByPath.get(key);
    if (!handle) {
      return;
    }
    this.openByPath.delete(key);
    this.connectPromises.delete(key);
    await handle.db.close();
  }

  async closeAll(): Promise<void> {
    const paths = [...this.openByPath.keys()];
    for (const key of paths) {
      const handle = this.openByPath.get(key);
      if (handle) {
        await handle.db.close();
      }
    }
    this.openByPath.clear();
    this.connectPromises.clear();
    this.operationChains.clear();
  }

  /** Pull remote generation before push — avoids target_pull_gen > source_pull_gen drift. */
  private async pullAndPushReplica(handle: OpenReplicaHandle): Promise<void> {
    await handle.db.pull();
    await handle.db.push();
    markTursoReplicaReachable();
  }

  private async withSerializedPath<T>(
    localPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = normalizeDbPath(localPath);
    const prev = this.operationChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.operationChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async getOrOpen(options: {
    localPath: string;
    tursoDatabase: string;
    bootstrapIfEmpty?: boolean;
    clientName?: string;
    /** Pull remote frames once when opening (read/status paths). Writes pull in pullAndPushReplica. */
    syncOnOpen?: boolean;
    /** Optional source for inbound CDC drain after syncOnOpen pull. */
    inboundDrainSource?: AppDataSource;
  }): Promise<OpenReplicaHandle> {
    const key = normalizeDbPath(options.localPath);
    const existing = this.openByPath.get(key);
    if (existing) {
      return existing;
    }

    const inFlight = this.connectPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.openConnection(options);
    this.connectPromises.set(key, promise);
    try {
      const handle = await promise;
      this.openByPath.set(key, handle);
      return handle;
    } finally {
      this.connectPromises.delete(key);
    }
  }

  private async openConnection(options: {
    localPath: string;
    tursoDatabase: string;
    bootstrapIfEmpty?: boolean;
    clientName?: string;
    syncOnOpen?: boolean;
    inboundDrainSource?: AppDataSource;
  }): Promise<OpenReplicaHandle> {
    const bridge = getTursoSyncBridge();
    if (!bridge?.enabled) {
      throw new Error("Turso sync bridge not available — sign in to Papr");
    }

    try {
      const creds = await bridge.fetchCredentials(options.tursoDatabase);
      const db = await connectTursoReplica({
        localPath: options.localPath,
        tursoUrl: creds.tursoUrl,
        authToken: creds.authToken,
        bootstrapIfEmpty: options.bootstrapIfEmpty,
        clientName: options.clientName,
      });
      if (
        options.syncOnOpen &&
        isTursoReplicaOnline() &&
        fs.existsSync(options.localPath) &&
        options.bootstrapIfEmpty !== true
      ) {
        await db.pull();
        if (options.inboundDrainSource) {
          await drainInboundReplicaCdcIfCaughtUp({
            source: options.inboundDrainSource,
            tursoDatabase: options.tursoDatabase,
          });
        }
      }
      markTursoReplicaReachable();

      return {
        db,
        tursoDatabase: options.tursoDatabase,
        localPath: normalizeDbPath(options.localPath),
      };
    } catch (error) {
      noteTursoReplicaTransportError(error);
      throw error;
    }
  }
}

let serviceInstance: TursoReplicaService | null = null;

export function getTursoReplicaService(): TursoReplicaService {
  if (!serviceInstance) {
    serviceInstance = new TursoReplicaService();
  }
  return serviceInstance;
}

export function resetTursoReplicaServiceForTests(): void {
  void serviceInstance?.closeAll();
  serviceInstance = null;
}

export { isTursoHostNotReadyError };
