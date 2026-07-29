/**
 * Global concurrency gate for LLM agent streams (user chat + scheduled jobs).
 * Prevents unbounded parallel pi-ai / AI SDK sessions from exhausting Gateway heap.
 */

export const DEFAULT_AGENT_STREAM_MAX_CONCURRENT = 2;

/** Max wait before rejecting a new stream (jobs queue; user chat gets a clear error). */
export const AGENT_STREAM_ACQUIRE_TIMEOUT_MS = 120_000;

export class AgentStreamConcurrencyTimeoutError extends Error {
  readonly maxConcurrent: number;
  readonly activeCount: number;

  constructor(maxConcurrent: number, activeCount: number) {
    super(
      `Too many concurrent agent sessions (${activeCount}/${maxConcurrent}). ` +
        "Try again shortly, start a fresh chat, or stagger scheduled agent jobs.",
    );
    this.name = "AgentStreamConcurrencyTimeoutError";
    this.maxConcurrent = maxConcurrent;
    this.activeCount = activeCount;
  }
}

function readMaxConcurrent(): number {
  const raw = process.env.AGENT_STREAM_MAX_CONCURRENT;
  if (!raw) {
    return DEFAULT_AGENT_STREAM_MAX_CONCURRENT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_AGENT_STREAM_MAX_CONCURRENT;
  }
  return parsed;
}

interface Waiter {
  chatId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
}

export interface AgentStreamConcurrencyStats {
  maxConcurrent: number;
  activeCount: number;
  waitingCount: number;
  activeChatIds: string[];
}

export class AgentStreamConcurrencyGate {
  private readonly maxConcurrent = readMaxConcurrent();
  private activeCount = 0;
  private readonly activeChatIds = new Set<string>();
  private readonly waitQueue: Waiter[] = [];

  getStats(): AgentStreamConcurrencyStats {
    return {
      maxConcurrent: this.maxConcurrent,
      activeCount: this.activeCount,
      waitingCount: this.waitQueue.length,
      activeChatIds: [...this.activeChatIds],
    };
  }

  async acquire(chatId: string, signal?: AbortSignal): Promise<void> {
    if (this.activeChatIds.has(chatId)) {
      return;
    }

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      this.activeChatIds.add(chatId);
      return;
    }

    if (signal?.aborted) {
      throw new Error("Agent stream cancelled while waiting for concurrency slot");
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        chatId,
        resolve: () => {},
        reject,
        timer: null,
        onAbort: null,
      };

      const removeFromQueue = (): void => {
        const index = this.waitQueue.indexOf(waiter);
        if (index >= 0) {
          this.waitQueue.splice(index, 1);
        }
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        if (waiter.onAbort && signal) {
          signal.removeEventListener("abort", waiter.onAbort);
          waiter.onAbort = null;
        }
      };

      waiter.resolve = () => {
        removeFromQueue();
        this.activeCount += 1;
        this.activeChatIds.add(chatId);
        resolve();
      };

      waiter.onAbort = () => {
        removeFromQueue();
        reject(new Error("Agent stream cancelled while waiting for concurrency slot"));
      };

      signal?.addEventListener("abort", waiter.onAbort, { once: true });

      waiter.timer = setTimeout(() => {
        removeFromQueue();
        reject(
          new AgentStreamConcurrencyTimeoutError(
            this.maxConcurrent,
            this.activeCount,
          ),
        );
      }, AGENT_STREAM_ACQUIRE_TIMEOUT_MS);

      this.waitQueue.push(waiter);

      console.log(
        `[AgentStreamConcurrency] Queued ${chatId} — ` +
          `${this.activeCount}/${this.maxConcurrent} active, ` +
          `${this.waitQueue.length} waiting`,
      );
    });
  }

  release(chatId: string): void {
    if (!this.activeChatIds.has(chatId)) {
      return;
    }

    this.activeChatIds.delete(chatId);
    this.activeCount = Math.max(0, this.activeCount - 1);

    const next = this.waitQueue.shift();
    if (next) {
      next.resolve();
      console.log(
        `[AgentStreamConcurrency] Admitted queued ${next.chatId} — ` +
          `${this.activeCount}/${this.maxConcurrent} active`,
      );
    }
  }
}

let gateInstance: AgentStreamConcurrencyGate | null = null;

export function getAgentStreamConcurrencyGate(): AgentStreamConcurrencyGate {
  if (!gateInstance) {
    gateInstance = new AgentStreamConcurrencyGate();
  }
  return gateInstance;
}

/** Test helper — reset singleton between vitest cases. */
export function resetAgentStreamConcurrencyGateForTests(): void {
  gateInstance = null;
}
