/** Metadata only: never SQL text, parameters, rows, or authentication data. */
export interface DatabaseOperation { id: string; kind: string; startedAt: string }
export interface DatabaseConnectionRecord {
  connectionId: string; sourceId: string; pid: number; threadId: number;
  owner: string; engine: "better-sqlite3" | "turso";
  pathId: string; databaseId: string; databasePath: string; identity: "path" | "file" | "memory";
  openedAt: string; updatedAt: string;
  transaction: { state: "none" | "active" | "unknown"; since: string | null };
  operations: DatabaseOperation[];
}
export interface DatabaseCompletion {
  connection: DatabaseConnectionRecord; operation: DatabaseOperation;
  finishedAt: string; durationMs: number; outcome: "ok" | "error"; errorCode?: string;
}
export type DatabaseTraceMessage =
  | { type: "hello"; sourceId: string; pid: number; threadId: number }
  | { type: "upsert"; record: DatabaseConnectionRecord }
  | { type: "remove"; connectionId: string }
  | { type: "completed"; completion: DatabaseCompletion }
  | { type: "activity"; connectionId: string; updatedAt: string; operations: DatabaseOperation[]; transaction: DatabaseConnectionRecord["transaction"] }
  | { type: "snapshot"; records: DatabaseConnectionRecord[] }
  | { type: "reset" }
  | { type: "status"; droppedUpdates: number; coalescedUpdates?: number; droppedHistory?: number; capacityDrops?: number; pendingHistory?: number; resyncPending?: boolean };
