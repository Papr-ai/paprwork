/** Separate concurrency pools for interactive chats and background agent jobs. */

export const DEFAULT_AGENT_STREAM_MAX_CONCURRENT = 6;
export const AGENT_STREAM_ACQUIRE_TIMEOUT_MS = 5_000;
export const BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS = 120_000;

export type AgentStreamPool = "chat" | "job";

export interface AgentStreamConcurrencyLease {
  chatId: string;
  token: symbol;
  pool: AgentStreamPool;
}

export class AgentStreamConcurrencyTimeoutError extends Error {
  constructor(
    readonly pool: AgentStreamPool,
    readonly maxConcurrent: number,
    readonly activeCount: number,
    readonly activeChatIds: string[] = [],
  ) {
    super(
      `Too many concurrent ${pool} agent sessions (${activeCount}/${maxConcurrent}). ` +
        "Another session is still running; stop it or try again shortly.",
    );
    this.name = "AgentStreamConcurrencyTimeoutError";
  }
}

export interface AgentStreamPoolStats {
  pool: AgentStreamPool;
  maxConcurrent: number;
  activeCount: number;
  waitingCount: number;
  activeChatIds: string[];
}

export interface AgentStreamConcurrencyStats {
  chat: AgentStreamPoolStats;
  job: AgentStreamPoolStats;
}

export type AgentStreamQueueEvent =
  | {
      type: "queued";
      pool: AgentStreamPool;
      activeCount: number;
      maxConcurrent: number;
      waitingCount: number;
    }
  | {
      type: "admitted";
      lease: AgentStreamConcurrencyLease;
      pool: AgentStreamPool;
      activeCount: number;
      maxConcurrent: number;
    };

function readMaxConcurrent(): number {
  const parsed = Number.parseInt(process.env.AGENT_STREAM_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_AGENT_STREAM_MAX_CONCURRENT;
}

export function resolveAgentStreamPool(chatId: string): AgentStreamPool {
  return chatId.startsWith("job:") ? "job" : "chat";
}

interface Waiter {
  lease: AgentStreamConcurrencyLease;
  resolve: (lease: AgentStreamConcurrencyLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class AgentStreamPoolGate {
  constructor(
    readonly pool: AgentStreamPool,
    private readonly maxConcurrent: number,
    private readonly acquireTimeoutMs: number,
  ) {}

  private readonly active = new Map<string, AgentStreamConcurrencyLease>();
  private readonly waitQueue: Waiter[] = [];

  getStats(): AgentStreamPoolStats {
    return {
      pool: this.pool,
      maxConcurrent: this.maxConcurrent,
      activeCount: this.active.size,
      waitingCount: this.waitQueue.length,
      activeChatIds: [...this.active.keys()],
    };
  }

  forceReleaseByChatId(chatId: string): boolean {
    const existing = this.active.get(chatId);
    if (!existing) return false;
    this.active.delete(chatId);
    console.log(
      `[AgentStreamConcurrency] Force-released ${this.pool} lease for ${chatId}`,
    );
    this.drainQueue();
    return true;
  }

  async *acquireWithEvents(
    chatId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamQueueEvent, AgentStreamConcurrencyLease> {
    const lease: AgentStreamConcurrencyLease = {
      chatId,
      token: Symbol(chatId),
      pool: this.pool,
    };

    if (this.canAdmit(lease)) {
      const admitted = this.admit(lease);
      yield {
        type: "admitted",
        lease: admitted,
        pool: this.pool,
        activeCount: this.active.size,
        maxConcurrent: this.maxConcurrent,
      };
      return admitted;
    }

    if (signal?.aborted) throw this.cancelledError();

    const statsBeforeWait = this.getStats();
    yield {
      type: "queued",
      pool: this.pool,
      activeCount: statsBeforeWait.activeCount,
      maxConcurrent: statsBeforeWait.maxConcurrent,
      waitingCount: statsBeforeWait.waitingCount + 1,
    };

    if (signal?.aborted) throw this.cancelledError();

    const admittedLease = await new Promise<AgentStreamConcurrencyLease>(
      (resolve, reject) => {
        const waiter: Waiter = {
          lease,
          resolve,
          reject,
          timer: null,
          signal,
        };

        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          reject(this.cancelledError());
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });

        if (this.acquireTimeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            this.removeWaiter(waiter);
            const stats = this.getStats();
            reject(
              new AgentStreamConcurrencyTimeoutError(
                this.pool,
                stats.maxConcurrent,
                stats.activeCount,
                stats.activeChatIds,
              ),
            );
          }, this.acquireTimeoutMs);
        }

        this.waitQueue.push(waiter);
        console.log(
          `[AgentStreamConcurrency] Queued ${chatId} (${this.pool}) — ` +
            `${this.active.size}/${this.maxConcurrent} active, ` +
            `${this.waitQueue.length} waiting`,
        );
      },
    );

    yield {
      type: "admitted",
      lease: admittedLease,
      pool: this.pool,
      activeCount: this.active.size,
      maxConcurrent: this.maxConcurrent,
    };
    return admittedLease;
  }

  async acquire(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<AgentStreamConcurrencyLease> {
    let lease: AgentStreamConcurrencyLease | undefined;
    for await (const event of this.acquireWithEvents(chatId, signal)) {
      if (event.type === "queued") continue;
      lease = event.lease;
    }
    if (!lease) {
      throw new Error("Agent stream concurrency admission failed");
    }
    return lease;
  }

  release(lease: AgentStreamConcurrencyLease): void {
    const current = this.active.get(lease.chatId);
    if (!current || current.token !== lease.token) return;
    this.active.delete(lease.chatId);
    this.drainQueue();
  }

  private canAdmit(lease: AgentStreamConcurrencyLease): boolean {
    if (this.active.has(lease.chatId)) return false;
    return this.active.size < this.maxConcurrent;
  }

  private admit(lease: AgentStreamConcurrencyLease): AgentStreamConcurrencyLease {
    this.active.set(lease.chatId, lease);
    return lease;
  }

  private drainQueue(): void {
    let admitted = true;
    while (admitted) {
      admitted = false;
      const index = this.waitQueue.findIndex((waiter) =>
        this.canAdmit(waiter.lease),
      );
      if (index < 0) break;
      const waiter = this.waitQueue[index];
      this.removeWaiter(waiter);
      waiter.resolve(this.admit(waiter.lease));
      admitted = true;
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waitQueue.indexOf(waiter);
    if (index >= 0) this.waitQueue.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }

  private cancelledError(): Error {
    return new Error("Agent stream cancelled while waiting for concurrency slot");
  }
}

export class AgentStreamConcurrencyGate {
  private readonly chatGate: AgentStreamPoolGate;
  private readonly jobGate: AgentStreamPoolGate;

  constructor() {
    const maxConcurrent = readMaxConcurrent();
    // Chats wait until the user aborts — no timeout while queued for a slot.
    this.chatGate = new AgentStreamPoolGate("chat", maxConcurrent, 0);
    this.jobGate = new AgentStreamPoolGate(
      "job",
      maxConcurrent,
      BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
    );
  }

  private gateForPool(pool: AgentStreamPool): AgentStreamPoolGate {
    return pool === "job" ? this.jobGate : this.chatGate;
  }

  getStats(): AgentStreamConcurrencyStats {
    return {
      chat: this.chatGate.getStats(),
      job: this.jobGate.getStats(),
    };
  }

  /** @deprecated Prefer getStats().chat — kept for older callers. */
  getLegacyStats() {
    const chat = this.chatGate.getStats();
    return {
      maxConcurrent: chat.maxConcurrent,
      activeCount: chat.activeCount,
      waitingCount: chat.waitingCount,
      activeChatIds: chat.activeChatIds,
    };
  }

  async *acquireWithEvents(
    chatId: string,
    signal?: AbortSignal,
    pool: AgentStreamPool = resolveAgentStreamPool(chatId),
  ): AsyncGenerator<AgentStreamQueueEvent, AgentStreamConcurrencyLease> {
    return yield* this.gateForPool(pool).acquireWithEvents(chatId, signal);
  }

  async acquire(
    chatId: string,
    signal?: AbortSignal,
    pool: AgentStreamPool = resolveAgentStreamPool(chatId),
  ): Promise<AgentStreamConcurrencyLease> {
    let lease: AgentStreamConcurrencyLease | undefined;
    for await (const event of this.acquireWithEvents(chatId, signal, pool)) {
      if (event.type === "admitted") lease = event.lease;
    }
    if (!lease) {
      throw new Error("Agent stream concurrency admission failed");
    }
    return lease;
  }

  release(lease: AgentStreamConcurrencyLease): void {
    this.gateForPool(lease.pool).release(lease);
  }

  forceReleaseByChatId(chatId: string): boolean {
    return (
      this.chatGate.forceReleaseByChatId(chatId) ||
      this.jobGate.forceReleaseByChatId(chatId)
    );
  }
}

let gateInstance: AgentStreamConcurrencyGate | null = null;
export function getAgentStreamConcurrencyGate(): AgentStreamConcurrencyGate {
  return (gateInstance ??= new AgentStreamConcurrencyGate());
}
export function resetAgentStreamConcurrencyGateForTests(): void {
  gateInstance = null;
}
