/**
 * Sync worker core — WORKER PROCESS ONLY (and the in-process test shim).
 *
 * Owns the native Database handles and executes protocol requests against them. No I/O
 * here; tursoReplicaSyncWorkerEntry.ts wraps this in stdin/stdout. Keeping the engine logic
 * separate lets tests exercise it under a mocked `@tursodatabase/sync` without a child
 * process, while production still never loads the engine in the gateway.
 */

import { DatabaseConnectionTrace, databaseTracingEnabled } from "../databaseDiagnostics/trace.js";

import { connectTursoReplica } from "./tursoReplicaConnect.js";
import type {
  TursoSyncWorkerRequest,
  TursoSyncWorkerResult,
} from "./tursoReplicaSyncWorkerProtocol.js";
import { TursoReplicaPathScheduler } from "./tursoReplicaPathScheduler.js";
import type { TursoSyncWorkerOpTiming } from "./tursoReplicaSyncWorkerProtocol.js";

type Db = Awaited<ReturnType<typeof connectTursoReplica>>;

const IDLE_CLOSE_MS = 5 * 60_000;

interface Handle {
  db: Db;
  trace?: DatabaseConnectionTrace;
  idleTimer: NodeJS.Timeout | null;
}

export type WorkerLogger = (message: string) => void;

function isParallelReadWorkerOp(op: TursoSyncWorkerRequest["op"]): boolean {
  return op === "query" || op === "queryBatch";
}

function isExclusiveInteractiveWorkerOp(op: TursoSyncWorkerRequest["op"]): boolean {
  return op === "write" || op === "exec" || op === "connect" || op === "close";
}

export class TursoSyncWorkerCore {
  private readonly handles = new Map<string, Handle>();
  private readonly opening = new Map<string, Promise<Db>>();
  private readonly scheduler = new TursoReplicaPathScheduler();

  constructor(private readonly log: WorkerLogger = () => {}) {}

  /** Per-path scheduling; read queries may run parallel to pull when relaxed. */
  run(
    request: TursoSyncWorkerRequest,
  ): Promise<{ result: TursoSyncWorkerResult; opTiming: TursoSyncWorkerOpTiming }> {
    const queuedAt = Date.now();
    const runTask = () => this.handle(request, queuedAt);
    if (isParallelReadWorkerOp(request.op)) {
      return this.scheduler.runParallelRead(request.localPath, runTask);
    }
    if (isExclusiveInteractiveWorkerOp(request.op)) {
      return this.scheduler.runInteractive(request.localPath, runTask);
    }
    return this.scheduler.runBackground(request.localPath, runTask);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.handles.keys()].map((p) => this.closeHandle(p)));
  }

  openCount(): number {
    return this.handles.size;
  }

  private async handle(
    request: TursoSyncWorkerRequest,
    queuedAt: number,
  ): Promise<{ result: TursoSyncWorkerResult; opTiming: TursoSyncWorkerOpTiming }> {
    const startedAt = Date.now();
    const hadHandle = this.handles.has(request.localPath);
    let outcome = "ok";
    let result: TursoSyncWorkerResult = {};
    try {
      result = await this.execute(request);
      return {
        result,
        opTiming: {
          queueMs: startedAt - queuedAt,
          execMs: Date.now() - startedAt,
          opened: !hadHandle,
        },
      };
    } catch (error) {
      outcome = "error";
      // An engine error may leave the handle poisoned; drop it so the next request reopens.
      if (request.op !== "close") {
        await this.closeHandle(request.localPath);
      }
      throw error;
    } finally {
      this.armIdleClose(request.localPath);
      const now = Date.now();
      this.log(
        `op=${request.op} ${outcome} queueMs=${startedAt - queuedAt} execMs=${now - startedAt} ` +
          `opened=${!hadHandle} path=${request.localPath}`,
      );
    }
  }

  private async execute(request: TursoSyncWorkerRequest): Promise<TursoSyncWorkerResult> {
    if (request.op === "close") {
      await this.closeHandle(request.localPath);
      return {};
    }
    const db = await this.getOrOpen(request);
    const end = this.handles.get(request.localPath)?.trace?.begin(request.op);
    try {
      switch (request.op) {
        case "connect":
          return {};
        case "query": {
          const stmt = await db.prepare(request.sql ?? "");
          const rows = await stmt.all(...(request.params ?? []));
          return { rows: Array.isArray(rows) ? rows : [] };
        }
        case "queryBatch": {
          const results: { rows: unknown[] }[] = [];
          for (const statement of request.statements ?? []) {
            const stmt = await db.prepare(statement.sql);
            const rows = await stmt.all(...(statement.params ?? []));
            results.push({ rows: Array.isArray(rows) ? rows : [] });
          }
          return { results };
        }
        case "write": {
          let last = { changes: 0, lastInsertRowid: 0 };
          for (const statement of request.statements ?? []) {
            const stmt = await db.prepare(statement.sql);
            last = extractWriteMetrics(await stmt.run(...(statement.params ?? [])));
          }
          return last;
        }
        case "exec":
          await db.exec(request.sql ?? "");
          return {};
        case "pull":
          return { pulled: Boolean(await db.pull()) };
        case "push":
          await db.push();
          return { pulled: false };
        case "pullPush": {
          const pulled = Boolean(await db.pull());
          await db.push();
          return { pulled };
        }
        case "stats": {
          const stats = await db.stats();
          const cdcOperations =
            stats && typeof stats === "object" && "cdcOperations" in stats
              ? Number((stats as { cdcOperations: unknown }).cdcOperations)
              : 0;
          return { cdcOperations };
        }
        default: throw new Error("Unsupported sync worker operation");
      }
    } catch (error) {
      end?.(error);
      throw error;
    } finally {
      end?.();
    }
  }

  private async getOrOpen(request: TursoSyncWorkerRequest): Promise<Db> {
    const existing = this.handles.get(request.localPath);
    if (existing) {
      return existing.db;
    }
    const pending = this.opening.get(request.localPath);
    if (pending) {
      return pending;
    }
    const trace = databaseTracingEnabled() ? new DatabaseConnectionTrace(request.localPath, "turso-sync-worker", "turso") : undefined;
    const endOpen = trace?.begin("connect");
    const openPromise = connectTursoReplica({
      localPath: request.localPath,
      tursoUrl: request.tursoUrl,
      authToken: request.authToken,
      bootstrapIfEmpty: request.bootstrapIfEmpty,
      clientName: request.clientName,
    }).then((db) => {
      this.handles.set(request.localPath, { db, trace, idleTimer: null });
      endOpen?.();
      return db;
    }).catch(error => { endOpen?.(error); trace?.close(); throw error; });
    this.opening.set(request.localPath, openPromise);
    try {
      return await openPromise;
    } finally {
      this.opening.delete(request.localPath);
    }
  }

  private armIdleClose(localPath: string): void {
    const handle = this.handles.get(localPath);
    if (!handle) {
      return;
    }
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
    }
    handle.idleTimer = setTimeout(() => {
      void this.closeHandle(localPath);
    }, IDLE_CLOSE_MS);
    handle.idleTimer.unref();
  }

  private async closeHandle(localPath: string): Promise<void> {
    const handle = this.handles.get(localPath);
    if (!handle) {
      return;
    }
    this.handles.delete(localPath);
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
    }
    const endClose = handle.trace?.begin("close");
    try {
      await handle.db.close();
    } catch (error) {
      endClose?.(error);
      this.log(`close failed for ${localPath}: ${String(error)}`);
    } finally { endClose?.(); handle.trace?.close(); }
  }
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
