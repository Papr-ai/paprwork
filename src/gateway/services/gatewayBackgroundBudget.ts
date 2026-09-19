import { DiagnosticOperation, diagnosticErrorType, withDiagnosticContext } from "../../core/utils/performanceDiagnostics.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentStreamConcurrencyGate } from "./agent/agentStreamConcurrency.js";
import { getInteractiveHotPathDepth } from "./gatewayInteractivePriority.js";
import { resolveGatewayBackgroundMaxConcurrency } from "./gatewayBackgroundConcurrency.js";

export type BackgroundBudgetBlockReason =
  | "grace_period"
  | "interactive_busy"
  | "at_capacity"
  | "awaiting_drain";

interface Waiting {
  label: string; queuedAt: number; signal?: AbortSignal;
  resolve: (release: () => void) => void; reject: (error: Error) => void;
  abort: () => void;
}
/** One budget for coalesced maintenance, indexing and full job attempts.
 * Active work is not preempted. During chats, admit at most one background
 * task after the grace period, preventing starvation without starting a burst.
 */
export class BackgroundBudget {
  private active = new Map<symbol, string>();
  private waiting: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private context = new AsyncLocalStorage<symbol>();
  constructor(
    private capacity = resolveGatewayBackgroundMaxConcurrency,
    private busy = () => getInteractiveHotPathDepth() > 0 ||
      getAgentStreamConcurrencyGate().getStats().chat.activeCount > 0,
    private graceMs = () => {
      const value = Number(process.env.GATEWAY_BG_MAX_WAIT_MS ?? 120_000);
      return Number.isFinite(value) && value >= 0 ? value : 120_000;
    },
  ) {}
  private blockReasonFor(
    waiter: Waiting,
    busy: boolean,
    limit: number,
  ): BackgroundBudgetBlockReason {
    const waitedMs = Date.now() - waiter.queuedAt;
    if (busy && waitedMs < this.graceMs()) return "grace_period";
    if (this.active.size >= limit) {
      return busy && limit <= 1 ? "interactive_busy" : "at_capacity";
    }
    return "awaiting_drain";
  }
  stats() {
    const busy = this.busy();
    const limit = busy ? 1 : this.capacity();
    const blockingActive = [...this.active.values()];
    return {
      active: blockingActive,
      maxConcurrent: limit,
      interactiveBusy: busy,
      graceMs: this.graceMs(),
      capacityWhenIdle: this.capacity(),
      queued: this.waiting.map((w) => ({
        label: w.label,
        waitingMs: Date.now() - w.queuedAt,
        blockReason: this.blockReasonFor(w, busy, limit),
        blockingActive,
      })),
    };
  }
  async run<T>(label: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // Nested work belongs to the already admitted job/maintenance operation.
    const parent = this.context.getStore();
    if (parent && this.active.has(parent)) return work();
    const token = Symbol(label);
    const trace = new DiagnosticOperation("background", label, {}, true);
    let release: (() => void) | undefined;
    try {
      release = await this.acquire(label, token, signal);
      trace.start();
      signal?.throwIfAborted();
      const result = await this.context.run(token, () => withDiagnosticContext({ parentId: trace.id }, work));
      trace.finish("completed");
      return result;
    } catch (error) {
      trace.error(error);
      trace.finish(signal?.aborted || diagnosticErrorType(error) === "aborted" ? "cancelled" : "error");
      throw error;
    } finally { release?.(); }
  }
  private acquire(label: string, token: symbol, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiting = { label, queuedAt: Date.now(), signal, reject,
        resolve: release => { this.active.set(token, label); resolve(() => {
          this.active.delete(token); release();
        }); },
        abort: () => {
          this.waiting = this.waiting.filter(w => w !== waiter);
          reject(new Error("Background work cancelled")); this.drain();
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter); this.drain();
    });
  }
  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const busy = this.busy();
    const limit = busy ? 1 : this.capacity();
    while (this.waiting.length && this.active.size < limit) {
      const next = this.waiting[0];
      if (busy && Date.now() - next.queuedAt < this.graceMs()) break;
      this.waiting.shift();
      next.signal?.removeEventListener("abort", next.abort);
      next.resolve(() => this.drain());
    }
    if (this.waiting.length) this.timer = setTimeout(() => this.drain(), 100);
  }
}
export const gatewayBackgroundBudget = new BackgroundBudget();
