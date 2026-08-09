/** Global concurrency gate for user chats, embedded agents, and jobs. */

export const DEFAULT_AGENT_STREAM_MAX_CONCURRENT = 3;
export const AGENT_STREAM_ACQUIRE_TIMEOUT_MS = 5_000;
export const BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS = 120_000;

export type AgentStreamPriority = "foreground" | "background";

export interface AgentStreamConcurrencyLease {
  chatId: string;
  token: symbol;
  priority: AgentStreamPriority;
}

export class AgentStreamConcurrencyTimeoutError extends Error {
  constructor(
    readonly maxConcurrent: number,
    readonly activeCount: number,
    readonly activeChatIds: string[] = [],
  ) {
    super(
      `Too many concurrent agent sessions (${activeCount}/${maxConcurrent}). ` +
        "Another chat or agent is still running; stop it or try again shortly.",
    );
    this.name = "AgentStreamConcurrencyTimeoutError";
  }
}

function readMaxConcurrent(): number {
  const parsed = Number.parseInt(process.env.AGENT_STREAM_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_AGENT_STREAM_MAX_CONCURRENT;
}

interface Waiter {
  lease: AgentStreamConcurrencyLease;
  resolve: (lease: AgentStreamConcurrencyLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class AgentStreamConcurrencyGate {
  private readonly maxConcurrent = readMaxConcurrent();
  private readonly active = new Map<string, AgentStreamConcurrencyLease>();
  private readonly waitQueue: Waiter[] = [];

  getStats() {
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this.active.size,
      waitingCount: this.waitQueue.length,
      activeChatIds: [...this.active.keys()],
    };
  }

  async acquire(
    chatId: string,
    signal?: AbortSignal,
    priority: AgentStreamPriority = "foreground",
  ): Promise<AgentStreamConcurrencyLease> {
    const lease = { chatId, token: Symbol(chatId), priority };
    if (this.canAdmit(lease)) return this.admit(lease);
    if (signal?.aborted) throw this.cancelledError();

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { lease, resolve, reject, timer: null, signal };
      waiter.onAbort = () => {
        this.removeWaiter(waiter);
        reject(this.cancelledError());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const timeout = priority === "foreground"
        ? AGENT_STREAM_ACQUIRE_TIMEOUT_MS
        : BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS;
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        const stats = this.getStats();
        reject(new AgentStreamConcurrencyTimeoutError(
          stats.maxConcurrent,
          stats.activeCount,
          stats.activeChatIds,
        ));
      }, timeout);
      this.waitQueue.push(waiter);
      console.log(
        `[AgentStreamConcurrency] Queued ${chatId} (${priority}) — ` +
          `${this.active.size}/${this.maxConcurrent} active`,
      );
    });
  }

  release(lease: AgentStreamConcurrencyLease): void {
    const current = this.active.get(lease.chatId);
    if (!current || current.token !== lease.token) return;
    this.active.delete(lease.chatId);
    this.drainQueue();
  }

  private canAdmit(lease: AgentStreamConcurrencyLease): boolean {
    if (this.active.has(lease.chatId)) return false;
    if (this.active.size >= this.maxConcurrent) return false;
    if (lease.priority === "foreground" || this.maxConcurrent === 1) return true;
    // Keep one slot available for interactive chat when background work is running.
    return this.active.size < this.maxConcurrent - 1;
  }

  private admit(lease: AgentStreamConcurrencyLease): AgentStreamConcurrencyLease {
    this.active.set(lease.chatId, lease);
    return lease;
  }

  private drainQueue(): void {
    // Foreground waiters always get first chance at newly available capacity.
    this.waitQueue.sort((a, b) =>
      a.lease.priority === b.lease.priority ? 0 : a.lease.priority === "foreground" ? -1 : 1,
    );
    let admitted = true;
    while (admitted) {
      admitted = false;
      const index = this.waitQueue.findIndex((waiter) => this.canAdmit(waiter.lease));
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
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  private cancelledError(): Error {
    return new Error("Agent stream cancelled while waiting for concurrency slot");
  }
}

let gateInstance: AgentStreamConcurrencyGate | null = null;
export function getAgentStreamConcurrencyGate(): AgentStreamConcurrencyGate {
  return (gateInstance ??= new AgentStreamConcurrencyGate());
}
export function resetAgentStreamConcurrencyGateForTests(): void {
  gateInstance = null;
}
