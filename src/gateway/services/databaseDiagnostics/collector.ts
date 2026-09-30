import { createServer, type Server, type Socket } from "node:net";
import type { DatabaseCompletion, DatabaseConnectionRecord, DatabaseTraceMessage } from "./types.js";

interface Source { sourceId: string; pid: number; threadId: number; connected: boolean; lastSeenAt: string; droppedUpdates: number; coalescedUpdates?: number; droppedHistory?: number; capacityDrops?: number; pendingHistory?: number; resyncPending?: boolean }
const short = (s: unknown, max = 512): s is string => typeof s === "string" && s.length <= max;
function validRecord(value: unknown): value is DatabaseConnectionRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as DatabaseConnectionRecord;
  return short(r.connectionId) && short(r.sourceId) && Number.isInteger(r.pid) && Number.isInteger(r.threadId) &&
    short(r.owner, 160) && ["better-sqlite3", "turso"].includes(r.engine) && short(r.pathId) && short(r.databaseId) && short(r.databasePath, 4096) &&
    ["file", "path", "memory"].includes(r.identity) && short(r.openedAt, 40) && short(r.updatedAt, 40) &&
    Boolean(r.transaction && ["none", "active", "unknown"].includes(r.transaction.state)) &&
    (r.transaction.since === null || short(r.transaction.since, 40)) && Array.isArray(r.operations) && r.operations.length <= 16 &&
    r.operations.every(op => short(op.id) && short(op.kind, 80) && short(op.startedAt, 40));
}
export class DatabaseDiagnosticCollector {
  private readonly sources = new Map<string, Source>();
  private readonly connections = new Map<string, DatabaseConnectionRecord>();
  private readonly recent: DatabaseCompletion[] = [];
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  status = "not-started";
  droppedRecords = 0;
  async listen(endpoint: string): Promise<void> {
    this.server = createServer(socket => {
      if (this.sockets.size >= 64) { socket.destroy(); this.droppedRecords++; return; }
      this.sockets.add(socket);
      let sourceId: string | undefined;
      let buffer = "";
      socket.setEncoding("utf8"); socket.unref();
      socket.on("error", () => socket.destroy());
      socket.on("data", data => {
        buffer += data;
        if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); this.droppedRecords++; return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.length > 2 * 1024 * 1024) { socket.destroy(); this.droppedRecords++; return; }
          try {
            const message = JSON.parse(line) as DatabaseTraceMessage;
            if (message.type === "hello" && !sourceId && short(message.sourceId) && Number.isInteger(message.pid) && Number.isInteger(message.threadId)) {
              if (this.sources.size >= 64 && !this.sources.has(message.sourceId)) {
                const dead = [...this.sources.values()].find(source => !source.connected);
                if (dead) { this.removeSourceRecords(dead.sourceId); this.sources.delete(dead.sourceId); }
                else { this.droppedRecords++; socket.destroy(); return; }
              }
              sourceId = message.sourceId; this.removeSourceRecords(sourceId);
              this.sources.set(sourceId, { ...message, connected: true, lastSeenAt: new Date().toISOString(), droppedUpdates: 0 });
            } else if (sourceId) this.accept(sourceId, message);
          } catch { this.droppedRecords++; }
        }
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        const source = sourceId && this.sources.get(sourceId);
        if (source) source.connected = false;
      });
    });
    this.server.unref();
    await new Promise<void>(resolve => {
      this.server!.on("error", () => { this.status = "unavailable"; resolve(); });
      this.server!.listen(endpoint, () => { this.status = "listening"; resolve(); });
    });
  }
  private removeSourceRecords(sourceId: string): void {
    for (const [id, record] of this.connections) if (record.sourceId === sourceId) this.connections.delete(id);
  }
  private accept(sourceId: string, message: DatabaseTraceMessage): void {
    const source = this.sources.get(sourceId)!;
    source.lastSeenAt = new Date().toISOString();
    if (message.type === "reset") { this.removeSourceRecords(sourceId); return; }
    if (message.type === "status") {
      for (const key of ["droppedUpdates", "coalescedUpdates", "droppedHistory", "capacityDrops", "pendingHistory"] as const)
        source[key] = Math.max(0, Number(message[key]) || 0);
      source.resyncPending = message.resyncPending === true;
      return;
    }
    if (message.type === "snapshot") {
      if (!Array.isArray(message.records) || message.records.length > 256 ||
          !message.records.every(r => validRecord(r) && r.sourceId === sourceId && r.pid === source.pid && r.threadId === source.threadId)) { this.droppedRecords++; return; }
      const otherCount = [...this.connections.values()].filter(r => r.sourceId !== sourceId).length;
      if (otherCount + message.records.length > 512) { this.droppedRecords++; return; }
      this.removeSourceRecords(sourceId);
      for (const record of message.records) this.connections.set(record.connectionId, record);
      return;
    }
    if (message.type === "activity") {
      const previous = this.connections.get(message.connectionId);
      if (!previous || previous.sourceId !== sourceId) { this.droppedRecords++; return; }
      const updated = { ...previous, updatedAt: message.updatedAt, operations: message.operations, transaction: message.transaction };
      if (!validRecord(updated)) { this.droppedRecords++; return; }
      this.connections.set(updated.connectionId, updated); return;
    }
    if (message.type === "remove") {
      if (this.connections.get(message.connectionId)?.sourceId === sourceId) this.connections.delete(message.connectionId);
      return;
    }
    if (message.type === "upsert" && validRecord(message.record) && message.record.sourceId === sourceId &&
      message.record.pid === source.pid && message.record.threadId === source.threadId) {
      if (this.connections.size >= 512 && !this.connections.has(message.record.connectionId)) { this.droppedRecords++; return; }
      this.connections.set(message.record.connectionId, message.record);
    } else if (message.type === "completed" && message.completion && validRecord(message.completion.connection) &&
      message.completion.connection.sourceId === sourceId && Number.isFinite(message.completion.durationMs) &&
      short(message.completion.operation?.id) && short(message.completion.operation?.kind, 80) &&
      short(message.completion.operation?.startedAt, 40) && short(message.completion.finishedAt, 40) &&
      ["ok", "error"].includes(message.completion.outcome)) {
      this.recent.push(message.completion);
      if (this.recent.length > 128) this.recent.shift();
    }
  }
  snapshot() {
    return { status: this.status, droppedRecords: this.droppedRecords,
      sources: [...this.sources.values()].map(source => ({ ...source })),
      connections: [...this.connections.values()], recent: [...this.recent],
      coverage: "Instrumented SQLite opens and Turso worker operations only; external clients and engine-internal transactions are not fully observed." };
  }
  evidence(gatewayPid: number) {
    const snapshot = this.snapshot();
    const connected = (record: DatabaseConnectionRecord) => this.sources.get(record.sourceId)?.connected === true;
    const active = snapshot.connections.filter(record => connected(record) && (record.operations.length > 0 || record.transaction.state === "active"));
    return { capturedAt: new Date().toISOString(), droppedRecords: this.droppedRecords,
      sources: snapshot.sources,
      waitingCandidates: active.filter(record => record.pid === gatewayPid && record.threadId === 0 && record.operations.some(op => !op.kind.startsWith("cursor:"))).map(waiting => ({
        waiting,
        suspectedCompetingConnections: active.filter(other => other.connectionId !== waiting.connectionId && sameDatabase(waiting, other)),
        otherOpenConnections: snapshot.connections.filter(other => connected(other) && other.connectionId !== waiting.connectionId && sameDatabase(waiting, other)),
        attribution: "suspected-only" as const,
      })) };
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => { if (this.server?.listening) this.server.close(() => resolve()); else resolve(); });
    this.status = "stopped";
  }
}
export function sameDatabase(a: DatabaseConnectionRecord, b: DatabaseConnectionRecord): boolean {
  if (a.identity === "memory" || b.identity === "memory") return a.databaseId === b.databaseId;
  if (a.identity === "file" && b.identity === "file") return a.databaseId === b.databaseId;
  return a.pathId === b.pathId || a.databasePath === b.databasePath;
}
