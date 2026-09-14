/**
 * Per-DB-path scheduling for replica I/O.
 *
 * Default (relaxed): multiple read queries run concurrently on the same path; pull/push/checkpoint
 * still take the sync lane and do not overlap reads (reads wait for sync; sync waits for reads to drain).
 * Set PAPR_REPLICA_READ_DURING_SYNC=1 to allow read+pull overlap (Turso SDK experiment only).
 *
 * Strict (legacy): one op at a time per path — set PAPR_REPLICA_STRICT_PATH_QUEUE=1.
 */

import { markReplicaReadPhase } from "./replicaReadPhaseTrace.js";

const PRIORITY_INTERACTIVE = 10;
const PRIORITY_BACKGROUND = 1;

interface QueueItem {
  priority: number;
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function isReplicaPathQueueRelaxed(): boolean {
  return process.env.PAPR_REPLICA_STRICT_PATH_QUEUE !== "1";
}

/** When true, reads may run while pull/push holds the sync lane (legacy relaxed experiment). */
export function isReplicaReadDuringSyncEnabled(): boolean {
  return process.env.PAPR_REPLICA_READ_DURING_SYNC === "1";
}

function readMaxParallelReads(): number {
  const raw = process.env.PAPR_REPLICA_MAX_PARALLEL_READS?.trim();
  if (!raw) {
    return 16;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 16;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TursoReplicaPathScheduler {
  private readonly queues = new Map<string, QueueItem[]>();
  /** Strict mode: single lane per path. */
  private readonly active = new Map<string, boolean>();

  /** Relaxed mode: concurrent SELECT / queryBatch. */
  private readonly readInFlight = new Map<string, number>();
  /** Relaxed mode: at most one pull/push/checkpoint lane per path. */
  private readonly syncActive = new Map<string, boolean>();
  private readonly syncWaiters = new Map<string, Array<() => void>>();

  /** Mini-app hot path — parallel reads when relaxed. */
  runParallelRead<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    if (!isReplicaPathQueueRelaxed()) {
      return this.runInteractive(localPath, fn);
    }
    return this.runRelaxedParallelRead(localPath, fn);
  }

  runInteractive<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    if (!isReplicaPathQueueRelaxed()) {
      return this.enqueueStrict(localPath, PRIORITY_INTERACTIVE, fn);
    }
    return this.runRelaxedExclusive(localPath, fn);
  }

  runBackground<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    if (!isReplicaPathQueueRelaxed()) {
      return this.enqueueStrict(localPath, PRIORITY_BACKGROUND, fn);
    }
    return this.runRelaxedBackground(localPath, fn);
  }

  clear(): void {
    this.queues.clear();
    this.active.clear();
    this.readInFlight.clear();
    this.syncActive.clear();
    this.syncWaiters.clear();
  }

  private async runRelaxedParallelRead<T>(
    localPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    if (!isReplicaReadDuringSyncEnabled()) {
      while (this.syncActive.get(localPath)) {
        await sleep(2);
      }
    }
    const max = readMaxParallelReads();
    while ((this.readInFlight.get(localPath) ?? 0) >= max) {
      await sleep(2);
    }
    this.readInFlight.set(localPath, (this.readInFlight.get(localPath) ?? 0) + 1);
    markReplicaReadPhase("gatewayPathQueueMs", performance.now() - enqueuedAt);
    try {
      return await fn();
    } finally {
      const next = (this.readInFlight.get(localPath) ?? 1) - 1;
      if (next <= 0) {
        this.readInFlight.delete(localPath);
      } else {
        this.readInFlight.set(localPath, next);
      }
    }
  }

  private async runRelaxedExclusive<T>(
    localPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    await this.waitForRelaxedReadDrain(localPath);
    await this.acquireSyncLane(localPath);
    markReplicaReadPhase("gatewayPathQueueMs", performance.now() - enqueuedAt);
    try {
      return await fn();
    } finally {
      this.releaseSyncLane(localPath);
    }
  }

  private async runRelaxedBackground<T>(
    localPath: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    if (!isReplicaReadDuringSyncEnabled()) {
      await this.waitForRelaxedReadDrain(localPath);
    }
    await this.acquireSyncLane(localPath);
    markReplicaReadPhase("gatewayPathQueueMs", performance.now() - enqueuedAt);
    try {
      return await fn();
    } finally {
      this.releaseSyncLane(localPath);
    }
  }

  private async waitForRelaxedReadDrain(localPath: string): Promise<void> {
    while ((this.readInFlight.get(localPath) ?? 0) > 0) {
      await sleep(2);
    }
  }

  private async acquireSyncLane(localPath: string): Promise<void> {
    while (this.syncActive.get(localPath)) {
      await new Promise<void>((resolve) => {
        const list = this.syncWaiters.get(localPath) ?? [];
        list.push(resolve);
        this.syncWaiters.set(localPath, list);
      });
    }
    this.syncActive.set(localPath, true);
  }

  private releaseSyncLane(localPath: string): void {
    this.syncActive.set(localPath, false);
    const waiters = this.syncWaiters.get(localPath);
    if (!waiters || waiters.length === 0) {
      return;
    }
    const next = waiters.shift();
    if (waiters.length === 0) {
      this.syncWaiters.delete(localPath);
    }
    next?.();
  }

  private enqueueStrict<T>(
    localPath: string,
    priority: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(localPath) ?? [];
      queue.push({
        priority,
        enqueuedAt: performance.now(),
        run: () => fn(),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      queue.sort((left, right) => right.priority - left.priority);
      this.queues.set(localPath, queue);
      void this.pumpStrict(localPath);
    });
  }

  private async pumpStrict(localPath: string): Promise<void> {
    if (this.active.get(localPath)) {
      return;
    }
    const queue = this.queues.get(localPath);
    if (!queue || queue.length === 0) {
      return;
    }

    this.active.set(localPath, true);
    const item = queue.shift()!;
    if (queue.length === 0) {
      this.queues.delete(localPath);
    }

    markReplicaReadPhase("gatewayPathQueueMs", performance.now() - item.enqueuedAt);

    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error);
    } finally {
      this.active.set(localPath, false);
      void this.pumpStrict(localPath);
    }
  }
}
