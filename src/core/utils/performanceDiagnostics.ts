import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

export type DiagnosticKind = "chat" | "model" | "tool" | "background" | "setup" | "heap-snapshot" | "indexing";
export type DiagnosticOutcome = "completed" | "error" | "cancelled";
export interface DiagnosticContext { chatId?: string; provider?: string; model?: string; turnId?: string; parentId?: string }
const diagnosticContext = new AsyncLocalStorage<DiagnosticContext>();
export function withDiagnosticContext<T>(context: DiagnosticContext, work: () => T): T {
  return diagnosticContext.run(context, work);
}
export interface DiagnosticRecord extends DiagnosticContext {
  id: string;
  kind: DiagnosticKind;
  name: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: "queued" | "running" | DiagnosticOutcome;
  waits?: { startedAt: string; finishedAt?: string }[];
  queueMs?: number;
  durationMs?: number;
  totalMs?: number;
  firstResponseMs?: number;
  firstTextMs?: number;
  longestStreamGapMs: number;
  events: number;
  errorCount: number;
  errorType?: string;
  elapsedMs?: number;
  currentStreamGapMs?: number;
}
const RECENT_PER_KIND = 128;
const MAX_ACTIVE = 256;
const active = new Map<string, DiagnosticOperation>();
const recent = new Map<DiagnosticKind, DiagnosticRecord[]>();
let evictedActive = 0;
const label = (value: string) => value.slice(0, 160);

/** Classify without retaining exception messages, URLs, command output or credentials. */
export function diagnosticErrorType(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth++) {
    seen.add(current);
    const e = current as { name?: unknown; code?: unknown; statusCode?: unknown; status?: unknown; cause?: unknown; lastError?: unknown };
    if (e.name === "AbortError" || e.code === "ABORT_ERR") return "aborted";
    if (e.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(String(e.code))) return "timeout";
    const status = e.statusCode ?? e.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
    if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET"].includes(String(e.code))) return "network";
    current = e.lastError ?? e.cause;
  }
  return "error";
}

/** A small, metadata-only trace. Durations are monotonic; timestamps support correlation. */
export class DiagnosticOperation {
  private readonly queuedMono = performance.now();
  private startedMono?: number;
  private lastEventMono?: number;
  private finished = false;
  private queueStartedMono?: number;
  private cancellationRequested = false;
  private readonly record: DiagnosticRecord;

  constructor(kind: DiagnosticKind, name: string, context: DiagnosticContext = {}, queued = false) {
    context = { ...diagnosticContext.getStore(), ...Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) };
    this.record = {
      id: randomUUID(), kind, name: label(name),
      ...(context.chatId ? { chatId: label(context.chatId) } : {}),
      ...(context.provider ? { provider: label(context.provider) } : {}),
      ...(context.model ? { model: label(context.model) } : {}),
      ...(context.parentId ? { parentId: label(context.parentId) } : {}),
      ...(context.turnId ? { turnId: label(context.turnId) } : {}),
      queuedAt: new Date().toISOString(), status: "queued",
      events: 0, errorCount: 0, longestStreamGapMs: 0,
    };
    if (active.size >= MAX_ACTIVE) {
      active.delete(active.keys().next().value!);
      evictedActive++;
    }
    active.set(this.record.id, this);
    if (queued) this.record.waits = [{ startedAt: this.record.queuedAt }];
    if (!queued) this.start();
  }
  get id(): string { return this.record.id; }
  start(): void {
    if (this.finished || this.startedMono !== undefined) return;
    this.startedMono = performance.now();
    this.record.startedAt = new Date().toISOString();
    const wait = this.record.waits?.at(-1);
    if (wait && !wait.finishedAt) wait.finishedAt = this.record.startedAt;
    this.record.queueMs = this.startedMono - this.queuedMono;
    this.record.status = "running";
  }
  /** Chat queue timing is measured from the queue notification to admission. */
  setQueueMs(ms: number): void { this.record.queueMs = Math.max(0, ms); }
  queued(): void {
    if (this.finished || this.queueStartedMono !== undefined) return;
    this.queueStartedMono = performance.now();
    (this.record.waits ??= []).push({ startedAt: new Date().toISOString() });
    if (this.record.waits.length > 64) this.record.waits.shift();
    this.record.status = "queued";
  }
  admitted(): void {
    if (this.queueStartedMono !== undefined) {
      this.record.queueMs = (this.record.queueMs ?? 0) + performance.now() - this.queueStartedMono;
      this.queueStartedMono = undefined;
      const wait = this.record.waits?.at(-1);
      if (wait) wait.finishedAt = new Date().toISOString();
    }
    if (!this.finished) this.record.status = "running";
  }
  requestCancellation(): void { this.cancellationRequested = true; }
  event(text = false): void {
    if (this.finished) return;
    const now = performance.now();
    this.record.firstResponseMs ??= now - this.queuedMono;
    if (text) this.record.firstTextMs ??= now - this.queuedMono;
    if (this.lastEventMono !== undefined) {
      this.record.longestStreamGapMs = Math.max(this.record.longestStreamGapMs, now - this.lastEventMono);
    }
    this.lastEventMono = now;
    this.record.events++;
  }
  error(error?: unknown): void {
    if (this.finished) return;
    this.record.errorCount++;
    this.record.errorType = diagnosticErrorType(error);
  }
  finish(outcome: DiagnosticOutcome = "completed"): void {
    if (this.finished) return;
    this.admitted();
    this.finished = true;
    const now = performance.now();
    this.record.status = this.cancellationRequested ? "cancelled" : outcome;
    this.record.finishedAt = new Date().toISOString();
    const wait = this.record.waits?.at(-1);
    if (wait && !wait.finishedAt) wait.finishedAt = this.record.finishedAt;
    this.record.totalMs = now - this.queuedMono;
    if (this.startedMono !== undefined) this.record.durationMs = now - this.startedMono;
    else this.record.queueMs = this.record.totalMs;
    active.delete(this.record.id);
    const list = recent.get(this.record.kind) ?? [];
    list.push({ ...this.record });
    if (list.length > RECENT_PER_KIND) list.shift();
    recent.set(this.record.kind, list);
  }
  snapshot(): DiagnosticRecord {
    const now = performance.now();
    return { ...this.record, waits: this.record.waits?.map(wait => ({ ...wait })), elapsedMs: now - this.queuedMono,
      ...(this.queueStartedMono !== undefined ? { queueMs: (this.record.queueMs ?? 0) + now - this.queueStartedMono } :
        this.startedMono === undefined ? { queueMs: now - this.queuedMono } : {}),
      ...(this.lastEventMono !== undefined ? { currentStreamGapMs: now - this.lastEventMono } : {}),
    };
  }
}

export function getPerformanceDiagnostics() {
  return {
    active: [...active.values()].map(op => op.snapshot()),
    recent: [...recent.values()].flat().map(record => ({ ...record })).sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!)),
    retention: { maxActive: MAX_ACTIVE, recentPerKind: RECENT_PER_KIND, evictedActive },
  };
}
export function resetPerformanceDiagnosticsForTests(): void {
  active.clear(); recent.clear(); evictedActive = 0;
}

export function getActiveDiagnosticOperationIds(): string[] { return [...active.keys()]; }
export function markChatDiagnosticsCancelled(chatId: string): void {
  for (const operation of active.values()) {
    const record = operation.snapshot();
    if (record.kind === "chat" && record.chatId === chatId) operation.requestCancellation();
  }
}

/** Trace an awaited phase without changing its return value or error handling. */
export async function traceDiagnosticPhase<T>(name: string, work: () => Promise<T>, waiting = false): Promise<T> {
  const trace = new DiagnosticOperation("background", name, {}, waiting);
  return withDiagnosticContext({ ...diagnosticContext.getStore(), parentId: trace.id }, async () => {
    try { const value = await work(); trace.finish(); return value; }
    catch (error) { trace.error(error); trace.finish("error"); throw error; }
  });
}
