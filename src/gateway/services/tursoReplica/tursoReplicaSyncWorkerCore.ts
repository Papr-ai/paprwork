/**
 * Sync worker core — WORKER PROCESS ONLY (and the in-process test shim).
 *
 * Owns the native Database handles and executes protocol requests against them. No I/O
 * here; tursoReplicaSyncWorkerEntry.ts wraps this in stdin/stdout. Keeping the engine logic
 * separate lets tests exercise it under a mocked `@tursodatabase/sync` without a child
 * process, while production still never loads the engine in the gateway.
 */

import { connectTursoReplica } from "./tursoReplicaConnect.js";
import type {
  TursoSyncWorkerRequest,
  TursoSyncWorkerResult,
} from "./tursoReplicaSyncWorkerProtocol.js";

type Db = Awaited<ReturnType<typeof connectTursoReplica>>;

const IDLE_CLOSE_MS = 5 * 60_000;

interface Handle {
  db: Db;
  idleTimer: NodeJS.Timeout | null;
}

export type WorkerLogger = (message: string) => void;

export class TursoSyncWorkerCore {
  private readonly handles = new Map<string, Handle>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly log: WorkerLogger = () => {}) {}

  /** Serialise per path; different paths run concurrently. */
  run(request: TursoSyncWorkerRequest): Promise<TursoSyncWorkerResult> {
    const prev = this.chains.get(request.localPath) ?? Promise.resolve();
    const task = prev.then(() => this.handle(request));
    this.chains.set(
      request.localPath,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.handles.keys()].map((p) => this.closeHandle(p)));
  }

  openCount(): number {
    return this.handles.size;
  }

  private async handle(request: TursoSyncWorkerRequest): Promise<TursoSyncWorkerResult> {
    try {
      return await this.execute(request);
    } catch (error) {
      // An engine error may leave the handle poisoned; drop it so the next request reopens.
      if (request.op !== "close") {
        await this.closeHandle(request.localPath);
      }
      throw error;
    } finally {
      this.armIdleClose(request.localPath);
    }
  }

  private async execute(request: TursoSyncWorkerRequest): Promise<TursoSyncWorkerResult> {
    if (request.op === "close") {
      await this.closeHandle(request.localPath);
      return {};
    }
    const db = await this.getOrOpen(request);
    switch (request.op) {
      case "connect":
        return {};
      case "query": {
        const stmt = await db.prepare(request.sql ?? "");
        const rows = await stmt.all(...(request.params ?? []));
        return { rows: Array.isArray(rows) ? rows : [] };
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
    }
  }

  private async getOrOpen(request: TursoSyncWorkerRequest): Promise<Db> {
    const existing = this.handles.get(request.localPath);
    if (existing) {
      return existing.db;
    }
    const db = await connectTursoReplica({
      localPath: request.localPath,
      tursoUrl: request.tursoUrl,
      authToken: request.authToken,
      bootstrapIfEmpty: request.bootstrapIfEmpty,
      clientName: request.clientName,
    });
    this.handles.set(request.localPath, { db, idleTimer: null });
    return db;
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
    try {
      await handle.db.close();
    } catch (error) {
      this.log(`close failed for ${localPath}: ${String(error)}`);
    }
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
