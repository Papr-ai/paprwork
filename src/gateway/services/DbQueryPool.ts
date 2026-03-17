/**
 * Worker-thread pool for mini-app SQLite queries.
 *
 * Moves all synchronous better-sqlite3 calls off the Gateway's main event loop
 * so that health checks, WebSocket messages and other I/O are never starved —
 * even when a mini-app fires dozens of rapid DB queries.
 *
 * Features:
 *  - Configurable pool of N worker threads (default 2)
 *  - Per-app concurrency cap to prevent any single app from monopolising workers
 *  - Per-request timeout with automatic cleanup
 *  - Least-depth routing: new requests go to the worker with the shortest queue
 */

import { Worker } from "node:worker_threads";
import type {
  DbWorkerRequest,
  DbWorkerResponse,
} from "../workers/db-query-worker.js";

// ── Result types exposed to callers ───────────────────────────────────────

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  count: number;
}

export interface WriteResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SchemaTable {
  table: string;
  columns: Array<{ name: string; type: string; pk: boolean }>;
}

export interface SchemaResult {
  tables: SchemaTable[];
}

// ── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = 2;
const QUERY_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PER_APP = 4;

// ── Internal: single pooled worker ────────────────────────────────────────

interface Pending {
  resolve: (v: DbWorkerResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Queued {
  req: DbWorkerRequest;
  resolve: (v: DbWorkerResponse) => void;
  reject: (e: Error) => void;
}

class PooledWorker {
  private readonly worker: Worker;
  private pending = new Map<number, Pending>();
  private queue: Queued[] = [];
  private processing = false;
  private alive = true;

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl);

    this.worker.on("online", () => {
      console.log("[DbQueryPool] Worker thread online");
    });

    this.worker.on("message", (res: DbWorkerResponse) => {
      const entry = this.pending.get(res.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(res.id);
        entry.resolve(res);
      }
      this.processing = false;
      this.drain();
    });

    this.worker.on("error", (raw: unknown) => {
      const err = raw instanceof Error ? raw : new Error(String(raw));
      console.error("[DbQueryPool] Worker error:", err.message);
      this.rejectAll(err);
    });

    this.worker.on("exit", (code) => {
      this.alive = false;
      if (code !== 0) {
        console.error(`[DbQueryPool] Worker exited with code ${code}`);
        this.rejectAll(new Error(`DB worker exited unexpectedly (code ${code})`));
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const q of this.queue) q.reject(err);
    this.queue = [];
    this.processing = false;
  }

  get busy(): boolean {
    return this.processing;
  }

  /** Number of requests in-flight + queued. */
  get depth(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  execute(req: DbWorkerRequest): Promise<DbWorkerResponse> {
    return new Promise<DbWorkerResponse>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.drain();
    });
  }

  terminate(): void {
    const err = new Error("Worker terminated");
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const q of this.queue) q.reject(err);
    this.queue = [];
    this.worker.terminate();
  }

  // ── internal ──

  private drain(): void {
    if (this.processing || this.queue.length === 0) return;

    if (!this.alive) {
      this.rejectAll(new Error("DB worker is not running"));
      return;
    }

    const { req, resolve, reject } = this.queue.shift()!;
    this.processing = true;

    const timer = setTimeout(() => {
      this.pending.delete(req.id);
      reject(new Error(`DB query timed out after ${QUERY_TIMEOUT_MS}ms`));
      this.processing = false;
      this.drain();
    }, QUERY_TIMEOUT_MS);

    this.pending.set(req.id, { resolve, reject, timer });
    try {
      this.worker.postMessage(req);
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(req.id);
      this.processing = false;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ── Public pool class ─────────────────────────────────────────────────────

// ── Singleton access ──────────────────────────────────────────────────────

let poolInstance: DbQueryPool | undefined;

export function initializeDbPool(workerUrl: URL, poolSize?: number): DbQueryPool {
  if (poolInstance) return poolInstance;
  poolInstance = new DbQueryPool(workerUrl, poolSize);
  return poolInstance;
}

export function getDbPool(): DbQueryPool {
  if (!poolInstance) {
    throw new Error("[DbQueryPool] Not initialized — call initializeDbPool() first");
  }
  return poolInstance;
}

// ── Public pool class ─────────────────────────────────────────────────────

export class DbQueryPool {
  private workers: PooledWorker[] = [];
  private nextId = 0;
  private appInFlight = new Map<string, number>();

  constructor(workerUrl: URL, poolSize = DEFAULT_POOL_SIZE) {
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(new PooledWorker(workerUrl));
    }
    console.log(`[DbQueryPool] Initialized with ${poolSize} worker threads`);
  }

  // ── High-level API ──────────────────────────────────────────────────────

  async query(
    appId: string,
    dbPath: string,
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult> {
    await this.acquireSlot(appId);
    try {
      const res = await this.dispatch({
        type: "query",
        dbPath,
        sql,
        params,
        readonly: true,
      });
      return res.data as QueryResult;
    } finally {
      this.releaseSlot(appId);
    }
  }

  async write(
    appId: string,
    dbPath: string,
    sql: string,
    params?: unknown[],
  ): Promise<WriteResult> {
    await this.acquireSlot(appId);
    try {
      const res = await this.dispatch({
        type: "write",
        dbPath,
        sql,
        params,
        readonly: false,
      });
      return res.data as WriteResult;
    } finally {
      this.releaseSlot(appId);
    }
  }

  async exec(
    appId: string,
    dbPath: string,
    sql: string,
  ): Promise<void> {
    await this.acquireSlot(appId);
    try {
      await this.dispatch({ type: "exec", dbPath, sql, readonly: false });
    } finally {
      this.releaseSlot(appId);
    }
  }

  async schema(dbPath: string): Promise<SchemaResult> {
    const res = await this.dispatch({
      type: "schema",
      dbPath,
      readonly: true,
    });
    return res.data as SchemaResult;
  }

  async tableExists(dbPath: string, tableName: string): Promise<boolean> {
    const res = await this.dispatch({
      type: "table-exists",
      dbPath,
      tableName,
      readonly: true,
    });
    return (res.data as { exists: boolean }).exists;
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    console.log("[DbQueryPool] All workers terminated");
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async dispatch(
    partial: Omit<DbWorkerRequest, "id">,
  ): Promise<DbWorkerResponse> {
    const req: DbWorkerRequest = { ...partial, id: this.nextId++ } as DbWorkerRequest;
    const res = await this.pick().execute(req);
    if (!res.success) throw new Error(res.error ?? "Worker query failed");
    return res;
  }

  /** Pick the worker with the smallest queue depth. */
  private pick(): PooledWorker {
    let best = this.workers[0];
    for (const w of this.workers) {
      if (!w.busy) return w;
      if (w.depth < best.depth) best = w;
    }
    return best;
  }

  /** Block until the per-app concurrency limit has a free slot. */
  private async acquireSlot(appId: string): Promise<void> {
    while ((this.appInFlight.get(appId) ?? 0) >= MAX_CONCURRENT_PER_APP) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    this.appInFlight.set(appId, (this.appInFlight.get(appId) ?? 0) + 1);
  }

  private releaseSlot(appId: string): void {
    const n = this.appInFlight.get(appId) ?? 1;
    if (n <= 1) this.appInFlight.delete(appId);
    else this.appInFlight.set(appId, n - 1);
  }
}
