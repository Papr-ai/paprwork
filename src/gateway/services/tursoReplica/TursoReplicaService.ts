/**
 * Plan A — Turso Sync replica operations.
 *
 * This service never loads `@tursodatabase/sync`. Every operation is forwarded to the sync
 * worker child process (see TursoReplicaSyncWorkerClient), which owns the native engine and
 * the open Database handles. A Rust panic in the engine kills the worker, surfaces here as
 * a normal `TursoSyncWorkerCrashError`, and is repaired by resetting sync sidecars — the
 * gateway process cannot be taken down by this module.
 *
 * Public API is unchanged from the in-process implementation.
 */

import * as fs from "fs";
import * as path from "path";
import { ensureTursoSyncBridge } from "../TursoSyncBridge.js";
import { quoteIdent } from "../tursoSyncBridgeCore.js";
import type {
  TursoReplicaPushResponse,
  TursoReplicaSyncStatus,
  TursoReplicaWriteResult,
  TursoReplicaWriteOptions,
  DatabaseSyncMode,
} from "./tursoReplicaTypes.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import {
  getTursoReplicaSyncWorkerClient,
  shutdownTursoReplicaSyncWorker,
} from "./TursoReplicaSyncWorkerClient.js";
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
import { isTursoHostNotReadyError } from "./tursoReplicaErrors.js";

const REPLICA_STATUS_TIMEOUT_MS = 12_000;
const REPLICA_SYNC_TIMEOUT_MS = 15_000;
const REPLICA_QUERY_TIMEOUT_MS = 30_000;
const REPLICA_OPERATION_TIMEOUT_MS = 30_000;

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

interface RunWriteParams {
  localPath: string;
  tursoDatabase: string;
  sql: string;
  params?: unknown[];
  writeOptions?: TursoReplicaWriteOptions;
}

interface OpenSpec {
  localPath: string;
  tursoUrl: string;
  authToken: string;
  bootstrapIfEmpty: boolean;
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
  private readonly operationChains = new Map<string, Promise<unknown>>();
  /** Paths the worker has been asked to open at least once this process (for drain logging). */
  private readonly touchedPaths = new Set<string>();

  // ---- writes ---------------------------------------------------------------------------

  async runWrite(params: RunWriteParams): Promise<TursoReplicaWriteResult> {
    return this.runStatements({
      localPath: params.localPath,
      tursoDatabase: params.tursoDatabase,
      statements: [{ sql: params.sql, params: params.params }],
      writeOptions: params.writeOptions,
    });
  }

  async runStatements(options: {
    localPath: string;
    tursoDatabase: string;
    statements: ReadonlyArray<{ sql: string; params?: unknown[] }>;
    writeOptions?: TursoReplicaWriteOptions;
  }): Promise<TursoReplicaWriteResult> {
    const pushAfterWrite = options.writeOptions?.pushAfterWrite !== false;
    return this.withSerializedPath(options.localPath, async () => {
      const spec = await this.openSpec(options.localPath, options.tursoDatabase);
      const client = getTursoReplicaSyncWorkerClient();

      const metrics = await client.write({
        ...spec,
        statements: options.statements.map((s) => ({ sql: s.sql, params: s.params })),
        timeoutMs: REPLICA_QUERY_TIMEOUT_MS,
      });

      const pendingPush = await this.syncAfterWrite(spec, pushAfterWrite);
      return {
        changes: metrics.changes,
        lastInsertRowid: metrics.lastInsertRowid,
        pendingPush,
        backend: "turso-replica",
      };
    });
  }

  async runExec(
    localPath: string,
    tursoDatabase: string,
    sql: string,
    writeOptions?: TursoReplicaWriteOptions,
  ): Promise<{ pendingPush: boolean }> {
    const pushAfterWrite = writeOptions?.pushAfterWrite !== false;
    return this.withSerializedPath(localPath, async () => {
      const spec = await this.openSpec(localPath, tursoDatabase);
      await getTursoReplicaSyncWorkerClient().exec({
        ...spec,
        sql,
        timeoutMs: REPLICA_QUERY_TIMEOUT_MS,
      });
      const pendingPush = await this.syncAfterWrite(spec, pushAfterWrite);
      return { pendingPush };
    });
  }

  private async syncAfterWrite(spec: OpenSpec, pushAfterWrite: boolean): Promise<boolean> {
    if (!isTursoReplicaOnline() || !pushAfterWrite) {
      return true;
    }
    try {
      await this.syncWithRecovery(spec, "pullPush");
      return false;
    } catch (error) {
      noteTursoReplicaTransportError(error);
      throw new Error(`Turso replica push failed: ${(error as Error).message}`);
    }
  }

  // ---- sync -----------------------------------------------------------------------------

  async push(
    localPath: string,
    tursoDatabase: string,
    options?: { pullBeforePush?: boolean },
  ): Promise<TursoReplicaPushResponse> {
    try {
      await this.withSerializedPath(localPath, async () => {
        if (!isTursoReplicaOnline()) {
          return;
        }
        const spec = await this.openSpec(localPath, tursoDatabase);
        await this.syncWithRecovery(
          spec,
          options?.pullBeforePush === false ? "push" : "pullPush",
        );
      });
      return { ok: true };
    } catch (error) {
      noteTursoReplicaTransportError(error);
      return { ok: false, error: formatReplicaPushError((error as Error).message) };
    }
  }

  async pull(localPath: string, tursoDatabase: string): Promise<boolean> {
    return this.withSerializedPath(localPath, async () => {
      const spec = await this.openSpec(localPath, tursoDatabase);
      return this.syncWithRecovery(spec, "pull");
    });
  }

  /**
   * pull/push against the worker. Engine *errors* (not panics) about an unsatisfiable
   * checkpoint are recovered by resetting the sidecars and retrying once. Panics are
   * handled below us in the worker client.
   */
  private async syncWithRecovery(
    spec: OpenSpec,
    op: "pull" | "push" | "pullPush",
  ): Promise<boolean> {
    const client = getTursoReplicaSyncWorkerClient();
    const run = () =>
      withTimeout(
        client.sync({ ...spec, timeoutMs: REPLICA_SYNC_TIMEOUT_MS }, op),
        REPLICA_SYNC_TIMEOUT_MS + 1_000,
        `replica ${op}`,
      );
    try {
      const pulled = await run();
      markTursoReplicaReachable();
      return pulled;
    } catch (error) {
      if (!isReplicaCheckpointWalError((error as Error).message)) {
        throw error;
      }
      await client.close(spec.localPath);
      if (repairReplicaSidecarsOnCheckpointError(spec.localPath)) {
        console.warn(
          `[TursoReplicaService] Reset sync sidecars after checkpoint error: ${spec.localPath}`,
        );
      }
      const pulled = await run();
      markTursoReplicaReachable();
      return pulled;
    }
  }

  async readCdcOperations(localPath: string, tursoDatabase: string): Promise<number> {
    if (!isTursoReplicaSyncFeatureEnabled() || !fs.existsSync(localPath)) {
      return 0;
    }
    try {
      return await this.withSerializedPath(localPath, async () => {
        const spec = await this.openSpec(localPath, tursoDatabase, {
          bootstrapIfEmpty: false,
        });
        return getTursoReplicaSyncWorkerClient().stats({
          ...spec,
          timeoutMs: REPLICA_STATUS_TIMEOUT_MS,
        });
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

  // ---- reads ----------------------------------------------------------------------------

  async runQuery(options: {
    localPath: string;
    tursoDatabase: string;
    sql: string;
    params?: unknown[];
    pullBeforeRead?: boolean;
  }): Promise<import("../DbQueryPool.js").QueryResult> {
    return this.withSerializedPath(options.localPath, async () => {
      const executeRead = async (pullFirst: boolean) => {
        const spec = await this.openSpec(options.localPath, options.tursoDatabase);
        const client = getTursoReplicaSyncWorkerClient();
        if (isTursoReplicaOnline() && pullFirst) {
          await this.syncWithRecovery(spec, "pull");
        }
        const { rows: rawRows } = await client.query({
          ...spec,
          sql: options.sql,
          params: options.params,
          timeoutMs: REPLICA_QUERY_TIMEOUT_MS,
        });
        const rows = normalizeReplicaRows(rawRows);
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { rows, columns, count: rows.length };
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
        await this.recoverReadWedge(options.localPath);
        try {
          const spec = await this.openSpec(options.localPath, options.tursoDatabase);
          await this.syncWithRecovery(spec, "pull");
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
        const spec = await this.openSpec(localPath, tursoDatabase);
        const client = getTursoReplicaSyncWorkerClient();
        if (isTursoReplicaOnline() && pullFirst) {
          await this.syncWithRecovery(spec, "pull");
        }
        const query = (sql: string) =>
          client.query({ ...spec, sql, timeoutMs: REPLICA_QUERY_TIMEOUT_MS });

        const { rows: tableRows } = await query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        const tableNames = normalizeReplicaRows(tableRows)
          .map((row) => String(row.name ?? ""))
          .filter((name) => name.length > 0);

        const tables: import("../DbQueryPool.js").SchemaTable[] = [];
        for (const tableName of tableNames) {
          const { rows: colRows } = await query(
            `PRAGMA table_info(${quoteIdent(tableName)})`,
          );
          tables.push({
            table: tableName,
            columns: normalizeReplicaRows(colRows).map((column) => ({
              name: String(column.name ?? ""),
              type: String(column.type ?? ""),
              pk: Number(column.pk ?? 0) === 1,
            })),
          });
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
        await this.recoverReadWedge(localPath);
        try {
          const spec = await this.openSpec(localPath, tursoDatabase);
          await this.syncWithRecovery(spec, "pull");
          return await executeSchema(false);
        } catch {
          throw error;
        }
      }
    });
  }

  private async recoverReadWedge(localPath: string): Promise<void> {
    await getTursoReplicaSyncWorkerClient().close(localPath);
    if (repairReplicaSidecarWedge(localPath)) {
      console.warn(
        `[TursoReplicaService] Reset wedged sync sidecars during read recovery: ${localPath}`,
      );
    }
  }

  // ---- status ---------------------------------------------------------------------------

  async syncStatus(options: {
    localPath: string;
    tursoDatabase: string;
    syncMode?: DatabaseSyncMode;
    cutoverBlocked?: boolean;
    cutoverBlockReason?: string | null;
    lastPushError?: string | null;
    lastReplicaPushAt?: string | null;
    lastReplicaLocalMutationAt?: string | null;
    /** Accepted for API compatibility; inbound drain is driven by callers. */
    source?: AppDataSource;
  }): Promise<TursoReplicaSyncStatus> {
    const online = isTursoReplicaOnline();
    const syncMode = options.syncMode ?? "legacy";
    let pendingOps = 0;

    if (isTursoReplicaSyncFeatureEnabled() && fs.existsSync(options.localPath)) {
      pendingOps = await this.readCdcOperations(options.localPath, options.tursoDatabase);
    }

    const lastPushError = options.lastPushError ?? null;
    const migrationConflict =
      lastPushError?.startsWith(`${MIGRATION_CONFLICT_CODE}:`) ?? false;

    const pushAtMs = options.lastReplicaPushAt ? Date.parse(options.lastReplicaPushAt) : 0;
    const mutationAtMs = options.lastReplicaLocalMutationAt
      ? Date.parse(options.lastReplicaLocalMutationAt)
      : 0;
    const pushCoversLocalMutations =
      pushAtMs > 0 && (mutationAtMs === 0 || pushAtMs >= mutationAtMs);

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
      stats: pendingOps > 0 || fs.existsSync(options.localPath)
        ? { cdcOperations: pendingOps }
        : null,
    };
  }

  // ---- lifecycle ------------------------------------------------------------------------

  /** Ask the worker to release its handle for this path (callers that need the files). */
  async close(localPath: string): Promise<void> {
    const key = normalizeDbPath(localPath);
    this.touchedPaths.delete(key);
    await getTursoReplicaSyncWorkerClient().close(localPath);
  }

  getOpenConnectionCount(): number {
    return this.touchedPaths.size;
  }

  async closeAll(): Promise<void> {
    this.touchedPaths.clear();
    this.operationChains.clear();
    await shutdownTursoReplicaSyncWorker();
  }

  // ---- internals ------------------------------------------------------------------------

  private async openSpec(
    localPath: string,
    tursoDatabase: string,
    overrides?: { bootstrapIfEmpty?: boolean },
  ): Promise<OpenSpec> {
    const bridge = ensureTursoSyncBridge();
    if (!bridge.enabled) {
      throw new Error("Turso sync bridge not available — sign in to Papr");
    }
    // Cheap, file-only precheck for the one corruption shape we can see from outside: an
    // `-info` watermark past the end of `-wal`. Catching it here saves a worker crash +
    // respawn. Anything we *can't* see is caught by the worker crash policy instead.
    const key = normalizeDbPath(localPath);
    const report = inspectReplicaSidecarWedge(localPath);
    if (report.wedged) {
      if (this.touchedPaths.has(key)) {
        await getTursoReplicaSyncWorkerClient().close(localPath);
      }
      resetReplicaSidecars(localPath);
      console.warn(
        `[TursoReplicaService] Reset wedged sync sidecars before open: ${localPath} — ` +
          describeReplicaSidecarWedge(report),
      );
    }

    const localReplicaExists = fs.existsSync(localPath);
    try {
      const creds = await bridge.resolveCredentialsForReplicaOpen(tursoDatabase, {
        localReplicaExists,
      });
      this.touchedPaths.add(key);
      return {
        localPath,
        tursoUrl: creds.tursoUrl,
        authToken: creds.authToken,
        bootstrapIfEmpty: overrides?.bootstrapIfEmpty ?? !localReplicaExists,
      };
    } catch (error) {
      noteTursoReplicaTransportError(error);
      throw error;
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
}

let serviceInstance: TursoReplicaService | null = null;

export function getTursoReplicaService(): TursoReplicaService {
  if (!serviceInstance) {
    serviceInstance = new TursoReplicaService();
  }
  return serviceInstance;
}

/** Stop the worker (releases every replica file) — workspace switch, gateway shutdown. */
export async function drainTursoReplicaConnections(context: string): Promise<void> {
  // The worker may hold files even if this process never tracked a path (e.g. provision
  // ran directly against the client), so it is always stopped.
  await shutdownTursoReplicaSyncWorker();

  if (!serviceInstance) {
    return;
  }
  const openCount = serviceInstance.getOpenConnectionCount();
  if (openCount === 0) {
    return;
  }
  await serviceInstance.closeAll();
  console.log(
    `[TursoReplica] Drained ${openCount} replica connection(s) (${context})`,
  );
}

export function resetTursoReplicaServiceForTests(): void {
  // Drop the instance first so the drain below cannot call back into a spied closeAll.
  serviceInstance = null;
  void shutdownTursoReplicaSyncWorker();
}

export { isTursoHostNotReadyError };
