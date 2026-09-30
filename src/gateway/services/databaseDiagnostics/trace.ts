import { randomUUID, createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import os from "node:os";
import { threadId } from "node:worker_threads";
import type { DatabaseConnectionRecord, DatabaseOperation, DatabaseTraceMessage } from "./types.js";

const sourceId = `${process.pid}:${threadId}:${randomUUID()}`;
const connections = new Map<string, DatabaseConnectionTrace>();
let socket: Socket | undefined;
let connected = false;
let stopped = false;
let retryAfter = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let droppedUpdates = 0;
let needsResync = false;
let coalescedUpdates = 0;
let droppedHistory = 0;
let capacityDrops = 0;
const pendingHistory: Extract<DatabaseTraceMessage, { type: "completed" }>[] = [];
const MAX_HISTORY = 128;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const displayPath = (s: string) => s.startsWith(os.homedir() + path.sep) ? "~" + s.slice(os.homedir().length) : s;
export function databaseTracingEnabled(): boolean {
  return process.env.PAPR_DATABASE_DIAGNOSTICS !== "0" && Boolean(process.env.PAPR_DB_DIAGNOSTICS_SOCKET);
}
function writable(): boolean {
  return connected && !!socket && !socket.destroyed && socket.writableLength < 64 * 1024;
}
function write(message: DatabaseTraceMessage): void {
  socket!.write(JSON.stringify(message) + "\n");
}
function send(message: DatabaseTraceMessage): void {
  if (stopped) return;
  if (message.type === "completed") {
    // Freeze metadata now: deferred serialization must not turn an old event into current state.
    const frozen = structuredClone(message);
    if (pendingHistory.length >= MAX_HISTORY) { pendingHistory.shift(); droppedHistory++; droppedUpdates++; }
    pendingHistory.push(frozen);
  } else if (!writable() || needsResync) {
    if (message.type !== "status") { coalescedUpdates++; needsResync = true; }
  } else {
    try { write(message); } catch { needsResync = true; coalescedUpdates++; }
  }
  flush();
}
function flush(): void {
  if (!writable()) return;
  try {
    if (needsResync) {
      // One replacement message: the observer never sees a half-cleared snapshot.
      write({ type: "snapshot", records: [...connections.values()].map(trace => trace.record) });
      needsResync = false;
    }
    while (pendingHistory.length && writable()) { write(pendingHistory[0]); pendingHistory.shift(); }
  } catch { needsResync = true; }
}
/** Failed diagnostics never fail DB work. Each worker connects directly to the observer. */
export function startDatabaseDiagnosticTransport(): void {
  if (!databaseTracingEnabled()) return;
  stopped = false;
  if (!timer) {
    timer = setInterval(() => {
      startDatabaseDiagnosticTransport();
      if (connected) { if (needsResync) resync(); send({ type: "status", droppedUpdates, coalescedUpdates, droppedHistory, capacityDrops, pendingHistory: pendingHistory.length, resyncPending: needsResync }); }
    }, 1000);
    timer.unref();
  }
  if (socket || Date.now() < retryAfter) return;
  try {
    const instance = connect(process.env.PAPR_DB_DIAGNOSTICS_SOCKET!);
    socket = instance; instance.unref();
    instance.on("connect", () => {
      if (socket !== instance) return;
      connected = true; write({ type: "hello", sourceId, pid: process.pid, threadId }); resync();
    });
    instance.on("error", () => { instance.destroy(); });
    instance.on("close", () => {
      if (socket !== instance) return;
      connected = false; socket = undefined; retryAfter = Date.now() + 2000;
    });
    instance.on("drain", flush);
  } catch { socket = undefined; connected = false; retryAfter = Date.now() + 2000; }
}
function resync(): void { needsResync = true; flush(); }
export function stopDatabaseDiagnosticTransport(): void {
  stopped = true;
  droppedHistory += pendingHistory.length; droppedUpdates += pendingHistory.length;
  pendingHistory.length = 0; needsResync = false;
  if (timer) clearInterval(timer);
  timer = undefined; socket?.destroy(); socket = undefined; connected = false; retryAfter = 0;
}
export class DatabaseConnectionTrace {
  readonly record: DatabaseConnectionRecord;
  private closed = false;
  private tracked = false;
  constructor(dbPath: string, owner: string, engine: DatabaseConnectionRecord["engine"]) {
    const connectionId = randomUUID();
    const memory = !dbPath || dbPath === ":memory:";
    const absolute = memory ? ":memory:" : path.resolve(dbPath);
    const now = new Date().toISOString();
    this.record = { connectionId, sourceId, pid: process.pid, threadId, owner: owner.slice(0, 160), engine,
      pathId: hash(absolute), databaseId: memory ? connectionId : hash(absolute), databasePath: displayPath(absolute),
      identity: memory ? "memory" : "path", openedAt: now, updatedAt: now,
      transaction: { state: engine === "turso" ? "unknown" : "none", since: null }, operations: [] };
    if (connections.size < 256) { connections.set(connectionId, this); this.tracked = true; } else { droppedUpdates++; capacityDrops++; }
    startDatabaseDiagnosticTransport(); this.publish();
    // Resolve aliases asynchronously: do not introduce sync filesystem reads before native calls.
    if (!memory) void realpath(absolute).then(async canonical => {
      const info = await stat(canonical);
      if (this.closed) return;
      this.record.databaseId = hash(`${info.dev}:${info.ino}`);
      this.record.databasePath = displayPath(canonical); this.record.identity = "file"; this.publish();
    }).catch(() => {});
  }
  private publish(metadata = true): void {
    if (!this.tracked) return;
    this.record.updatedAt = new Date().toISOString();
    send(metadata ? { type: "upsert", record: this.record } : {
      type: "activity", connectionId: this.record.connectionId, updatedAt: this.record.updatedAt,
      transaction: this.record.transaction, operations: this.record.operations,
    });
  }
  transaction(active: boolean): void {
    const previous = this.record.transaction;
    if (previous.state === (active ? "active" : "none")) return;
    this.record.transaction = { state: active ? "active" : "none", since: active ? previous.since ?? new Date().toISOString() : null };
    this.publish(false);
  }
  begin(kind: string): (error?: unknown) => void {
    const operation: DatabaseOperation = { id: randomUUID(), kind: kind.slice(0, 80), startedAt: new Date().toISOString() };
    const mono = performance.now();
    if (this.record.operations.length < 16) this.record.operations.push(operation); else { droppedUpdates++; capacityDrops++; }
    this.publish(false);
    let finished = false;
    return (error?: unknown) => {
      if (finished) return;
      finished = true;
      const durationMs = performance.now() - mono;
      if (this.tracked && (durationMs >= 50 || error !== undefined || kind.includes("transaction"))) {
        const code = String((error as { code?: unknown } | undefined)?.code ?? "");
        send({ type: "completed", completion: { connection: this.record, operation,
          finishedAt: new Date().toISOString(), durationMs, outcome: error === undefined ? "ok" : "error",
          ...(error === undefined ? {} : { errorCode: /^SQLITE_[A-Z_]+$/.test(code) ? code : "error" }) } });
      }
      this.record.operations = this.record.operations.filter(op => op.id !== operation.id); this.publish(false);
    };
  }
  close(): void {
    this.closed = true; connections.delete(this.record.connectionId); if (this.tracked) send({ type: "remove", connectionId: this.record.connectionId });
  }
}
export function sqlOperationKind(sql: unknown): string {
  if (typeof sql !== "string") return "unknown";
  const text = sql.slice(0, 4096).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*(?:\n|$)/g, " ").trim();
  const word = text.match(/^[a-z]+/i)?.[0].toUpperCase();
  if (word === "SELECT") return "read";
  if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(word ?? "")) return "write";
  if (["CREATE", "ALTER", "DROP", "REINDEX", "VACUUM"].includes(word ?? "")) return "schema-change";
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(word ?? "")) return `transaction-${word!.toLowerCase()}`;
  if (word === "PRAGMA") return /\bwal_checkpoint\b/i.test(text) ? "checkpoint" : "pragma";
  return "unknown";
}

export function getDatabaseDiagnosticTransportStatus() {
  return { connected, droppedUpdates, coalescedUpdates, droppedHistory, capacityDrops, pendingHistory: pendingHistory.length, resyncPending: needsResync, trackedConnections: connections.size };
}
