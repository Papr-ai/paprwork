/**
 * Plan A — Turso Sync replica connections (one open Database per local db path).
 */

import * as fs from "fs";
import * as path from "path";
import type { Database } from "@tursodatabase/sync";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
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
import {
  isReplicaCheckpointWalError,
  isReplicaReadTransportError,
} from "./tursoReplicaCheckpointRecovery.js";
import {
  describeReplicaSidecarWedge,
  detectReplicaSidecarWedge,
  inspectReplicaSidecarWedge,
  repairReplicaSidecarWedge,
  repairReplicaSidecarsOnCheckpointError,
  resetReplicaSidecars,
} from "./tursoReplicaSidecarWedge.js";

const REPLICA_STATUS_OPEN_TIMEOUT_MS = 12_000;
const REPLICA_PULL_TIMEOUT_MS = 15_000;
const REPLICA_OPERATION_TIMEOUT_MS = 30_000;
const REPLICA_CONNECT_TIMEOUT_MS = 20_000;

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
      if (online) {
        await this.ensureSyncableSidecars(options.localPath, "write sync");
      }
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
          await this.pullAndPushReplicaWithRecovery(
            options.localPath,
            options.tursoDatabase,
            handle,
          );
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
      if (online) {
        await this.ensureSyncableSidecars(localPath, "exec sync");
      }
      const handle = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });

      await handle.db.exec(sql);

      let pendingPush = false;
      if (online) {
        try {
          await this.pullAndPushReplicaWithRecovery(
            localPath,
            tursoDatabase,
            handle,
          );
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
        if (isTursoReplicaOnline()) {
          await this.ensureSyncableSidecars(localPath, "push");
        }
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(localPath),
        });
        if (isTursoReplicaOnline()) {
          if (options?.pullBeforePush === false) {
            await this.pushOnlyWithRecovery(localPath, tursoDatabase, handle);
          } else {
            await this.pullAndPushReplicaWithRecovery(
              localPath,
              tursoDatabase,
              handle,
            );
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
      try {
        await this.ensureSyncableSidecars(localPath, "pull");
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(localPath),
        });
        const pulled = await withTimeout(
          handle.db.pull(),
          REPLICA_PULL_TIMEOUT_MS,
          "replica pull",
        );
        markTursoReplicaReachable();
        return pulled;
      } catch (error) {
        if (!isReplicaCheckpointWalError((error as Error).message)) {
          throw error;
        }
        await this.recoverSidecarsAfterCheckpointError(localPath);
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(localPath),
        });
        const pulled = await withTimeout(
          handle.db.pull(),
          REPLICA_PULL_TIMEOUT_MS,
          "replica pull after sidecar recovery",
        );
        markTursoReplicaReachable();
        return pulled;
      }
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
    // Intentionally unimplemented for Plan A replicas — checkpoint() after push
    // wedges @tursodatabase/sync sidecars (empty WAL vs stale -info metadata).
    void localPath;
    void tursoDatabase;
  }

  async runQuery(options: {
    localPath: string;
    tursoDatabase: string;
    sql: string;
    params?: unknown[];
    pullBeforeRead?: boolean;
  }): Promise<import("../DbQueryPool.js").QueryResult> {
    return this.withSerializedPath(options.localPath, async () => {
      const executeRead = async (pullFirst: boolean) => {
        const handle = await this.getOrOpen({
          localPath: options.localPath,
          tursoDatabase: options.tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(options.localPath),
        });

        if (isTursoReplicaOnline() && pullFirst) {
          await withTimeout(
            handle.db.pull(),
            REPLICA_PULL_TIMEOUT_MS,
            "replica pull before read",
          );
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
      };

      try {
        return await executeRead(options.pullBeforeRead === true);
      } catch (error) {
        const message = (error as Error).message;
        if (!isReplicaReadTransportError(message)) {
          throw error;
        }

        console.warn(
          `[TursoReplicaService] Read wedge on ${options.tursoDatabase} — ` +
            `recovering: ${message.slice(0, 160)}`,
        );
        await this.close(options.localPath);
        if (repairReplicaSidecarWedge(options.localPath)) {
          console.warn(
            `[TursoReplicaService] Reset wedged sync sidecars during read recovery: ${options.localPath}`,
          );
        }

        try {
          const handle = await this.getOrOpen({
            localPath: options.localPath,
            tursoDatabase: options.tursoDatabase,
            bootstrapIfEmpty: !fs.existsSync(options.localPath),
          });
          await withTimeout(
            handle.db.pull(),
            REPLICA_PULL_TIMEOUT_MS,
            "replica recovery pull",
          );
          await drainInboundReplicaCdcIfCaughtUp({
            source: {
              id: options.tursoDatabase,
              type: "sqlite",
              alias: options.tursoDatabase,
              dbPath: options.localPath,
              tables: [],
              linkedAt: new Date().toISOString(),
            },
            tursoDatabase: options.tursoDatabase,
          });
          return await executeRead(false);
        } catch (recoveryError) {
          noteTursoReplicaTransportError(recoveryError);
          throw error;
        }
      }
    });
  }

  async runSchema(
    localPath: string,
    tursoDatabase: string,
    options?: { pullBeforeRead?: boolean },
  ): Promise<import("../DbQueryPool.js").SchemaResult> {
    return this.withSerializedPath(localPath, async () => {
      const executeSchema = async (pullFirst: boolean) => {
        const handle = await this.getOrOpen({
          localPath,
          tursoDatabase,
          bootstrapIfEmpty: !fs.existsSync(localPath),
        });

        if (isTursoReplicaOnline() && pullFirst) {
          await withTimeout(
            handle.db.pull(),
            REPLICA_PULL_TIMEOUT_MS,
            "replica pull before schema",
          );
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
      };

      try {
        return await executeSchema(options?.pullBeforeRead === true);
      } catch (error) {
        const message = (error as Error).message;
        if (!isReplicaReadTransportError(message)) {
          throw error;
        }

        await this.close(localPath);
        if (repairReplicaSidecarWedge(localPath)) {
          console.warn(
            `[TursoReplicaService] Reset wedged sync sidecars during schema recovery: ${localPath}`,
          );
        }
        try {
          const handle = await this.getOrOpen({
            localPath,
            tursoDatabase,
            bootstrapIfEmpty: !fs.existsSync(localPath),
          });
          await withTimeout(
            handle.db.pull(),
            REPLICA_PULL_TIMEOUT_MS,
            "replica recovery pull",
          );
          return await executeSchema(false);
        } catch {
          throw error;
        }
      }
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
        await this.withSerializedPath(options.localPath, async () => {
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
        });
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
      sidecarWedge: detectReplicaSidecarWedge(options.localPath),
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

  getOpenConnectionCount(): number {
    return this.openByPath.size;
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
    await withTimeout(
      handle.db.pull(),
      REPLICA_PULL_TIMEOUT_MS,
      "replica pull before push",
    );
    await withTimeout(
      handle.db.push(),
      REPLICA_PULL_TIMEOUT_MS,
      "replica push",
    );
    markTursoReplicaReachable();
  }

  private async pullAndPushReplicaWithRecovery(
    localPath: string,
    tursoDatabase: string,
    handle: OpenReplicaHandle,
  ): Promise<void> {
    try {
      await this.pullAndPushReplica(handle);
    } catch (error) {
      if (!isReplicaCheckpointWalError((error as Error).message)) {
        throw error;
      }
      await this.recoverSidecarsAfterCheckpointError(localPath);
      const fresh = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });
      await this.pullAndPushReplica(fresh);
    }
  }

  private async pushOnlyWithRecovery(
    localPath: string,
    tursoDatabase: string,
    handle: OpenReplicaHandle,
  ): Promise<void> {
    try {
      await withTimeout(
        handle.db.push(),
        REPLICA_PULL_TIMEOUT_MS,
        "replica push",
      );
      markTursoReplicaReachable();
    } catch (error) {
      if (!isReplicaCheckpointWalError((error as Error).message)) {
        throw error;
      }
      await this.recoverSidecarsAfterCheckpointError(localPath);
      const fresh = await this.getOrOpen({
        localPath,
        tursoDatabase,
        bootstrapIfEmpty: !fs.existsSync(localPath),
      });
      await withTimeout(
        fresh.db.push(),
        REPLICA_PULL_TIMEOUT_MS,
        "replica push after sidecar recovery",
      );
      markTursoReplicaReachable();
    }
  }

  /**
   * Precondition for every sync call: the watermark in `-info` must name a frame the `-wal`
   * actually holds.
   *
   * An unsatisfiable watermark makes the engine abort the process from Rust, so there is no
   * error to recover from afterwards — the check has to happen before pull()/push() is reached.
   * Closing first matters: the repair unlinks the `-wal` the open handle is holding.
   */
  private async ensureSyncableSidecars(
    localPath: string,
    context: string,
  ): Promise<boolean> {
    const report = inspectReplicaSidecarWedge(localPath);
    if (!report.wedged) {
      return false;
    }
    await this.close(localPath);
    resetReplicaSidecars(localPath);
    console.warn(
      `[TursoReplicaService] Reset wedged sync sidecars before ${context}: ` +
        `${localPath} — ${describeReplicaSidecarWedge(report)}`,
    );
    return true;
  }

  private async recoverSidecarsAfterCheckpointError(
    localPath: string,
  ): Promise<void> {
    await this.close(localPath);
    if (repairReplicaSidecarsOnCheckpointError(localPath)) {
      console.warn(
        `[TursoReplicaService] Reset sync sidecars after checkpoint error: ${localPath}`,
      );
    }
  }

  private async withSerializedPath<T>(
    localPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = normalizeDbPath(localPath);
    const prev = this.operationChains.get(key) ?? Promise.resolve();

    const run = () =>
      withTimeout(fn(), REPLICA_OPERATION_TIMEOUT_MS, `replica operation (${key})`);

    const next = prev.then(run, run);
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
    const bridge = ensureTursoSyncBridge();
    if (!bridge.enabled) {
      throw new Error("Turso sync bridge not available — sign in to Papr");
    }

    // Cold path (startup, reconnect, post-close): sidecars left by an unclean shutdown are
    // repaired here, before the engine can be handed an unsatisfiable watermark.
    await this.ensureSyncableSidecars(options.localPath, "connect");

    const localReplicaExists = fs.existsSync(options.localPath);
    const bootstrapIfEmpty =
      options.bootstrapIfEmpty ?? !localReplicaExists;

    try {
      const creds = await bridge.resolveCredentialsForReplicaOpen(
        options.tursoDatabase,
        { localReplicaExists },
      );
      const db = await withTimeout(
        connectTursoReplica({
          localPath: options.localPath,
          tursoUrl: creds.tursoUrl,
          authToken: creds.authToken,
          bootstrapIfEmpty,
          clientName: options.clientName,
        }),
        REPLICA_CONNECT_TIMEOUT_MS,
        "replica connect",
      );
      if (
        options.syncOnOpen &&
        isTursoReplicaOnline() &&
        localReplicaExists &&
        bootstrapIfEmpty !== true
      ) {
        await withTimeout(
          db.pull(),
          REPLICA_PULL_TIMEOUT_MS,
          "replica pull on open",
        );
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

/** Close all embedded replica handles (workspace switch, gateway shutdown). */
export async function drainTursoReplicaConnections(context: string): Promise<void> {
  if (!serviceInstance) {
    return;
  }
  const openCount = serviceInstance.getOpenConnectionCount();
  if (openCount === 0) {
    return;
  }
  await serviceInstance.closeAll();
  console.log(
    `[TursoReplica] Drained ${openCount} open replica connection(s) (${context})`,
  );
}

export function resetTursoReplicaServiceForTests(): void {
  void drainTursoReplicaConnections("test reset");
  serviceInstance = null;
}

export { isTursoHostNotReadyError };
