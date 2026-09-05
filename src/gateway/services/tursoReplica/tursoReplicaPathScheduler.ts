/**
 * Per-DB-path priority queue — interactive reads/writes jump ahead of queued pull/push.
 */

const PRIORITY_INTERACTIVE = 10;
const PRIORITY_BACKGROUND = 1;

interface QueueItem {
  priority: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class TursoReplicaPathScheduler {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly active = new Map<string, boolean>();

  runInteractive<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(localPath, PRIORITY_INTERACTIVE, fn);
  }

  runBackground<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(localPath, PRIORITY_BACKGROUND, fn);
  }

  clear(): void {
    this.queues.clear();
    this.active.clear();
  }

  private enqueue<T>(
    localPath: string,
    priority: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(localPath) ?? [];
      queue.push({
        priority,
        run: () => fn(),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      queue.sort((left, right) => right.priority - left.priority);
      this.queues.set(localPath, queue);
      void this.pump(localPath);
    });
  }

  private async pump(localPath: string): Promise<void> {
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

    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error);
    } finally {
      this.active.set(localPath, false);
      void this.pump(localPath);
    }
  }
}
