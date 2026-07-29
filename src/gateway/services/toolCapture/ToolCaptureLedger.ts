import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePaprUserDataPath } from "../../../core/utils/paprWorkspace.js";

export type ToolCaptureSyncStatus =
  | "pending"
  | "synced"
  | "skipped_duplicate"
  | "failed";

export interface ToolCaptureInsertInput {
  dedupKey: string;
  contentHash: string;
  chatId: string;
  toolName: string;
  keysUsed: string[];
  inferredLabel: string;
  contentDate: string;
  inferredSubject?: string;
  body: string;
  toolCallId?: string;
}

export interface ToolCaptureRow {
  id: string;
  dedup_key: string;
  content_hash: string;
  chat_id: string;
  tool_call_id: string | null;
  tool_name: string;
  keys_used: string;
  inferred_label: string;
  content_date: string;
  inferred_subject: string | null;
  captured_at: string;
  result_size: number;
  body: string;
  memory_id: string | null;
  sync_status: ToolCaptureSyncStatus;
  sync_error: string | null;
  memory_synced_at: string | null;
}

export class ToolCaptureLedger {
  private db: Database.Database;

  constructor(dataDir?: string) {
    const baseDir = dataDir ?? resolvePaprUserDataPath();
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    const dbPath = path.join(baseDir, "tool-captures.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -5000");
    this.db.pragma("mmap_size = 15000000");
    this.db.pragma("temp_store = MEMORY");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_captures (
        id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        keys_used TEXT NOT NULL,
        inferred_label TEXT NOT NULL,
        content_date TEXT NOT NULL,
        inferred_subject TEXT,
        captured_at TEXT NOT NULL,
        result_size INTEGER NOT NULL,
        body TEXT NOT NULL,
        memory_id TEXT,
        sync_status TEXT NOT NULL,
        sync_error TEXT,
        memory_synced_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tool_captures_sync_status
        ON tool_captures(sync_status);
      CREATE INDEX IF NOT EXISTS idx_tool_captures_captured_at
        ON tool_captures(captured_at);
    `);
  }

  tryInsertCapture(input: ToolCaptureInsertInput): ToolCaptureRow | null {
    const existingByHash = this.db
      .prepare(
        `SELECT id FROM tool_captures WHERE content_hash = ? LIMIT 1`,
      )
      .get(input.contentHash) as { id: string } | undefined;
    if (existingByHash) {
      return null;
    }

    const existingByDedup = this.db
      .prepare(`SELECT id FROM tool_captures WHERE dedup_key = ? LIMIT 1`)
      .get(input.dedupKey) as { id: string } | undefined;
    if (existingByDedup) {
      return null;
    }

    const id = randomUUID();
    const capturedAt = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO tool_captures (
            id, dedup_key, content_hash, chat_id, tool_call_id, tool_name,
            keys_used, inferred_label, content_date, inferred_subject,
            captured_at, result_size, body, sync_status
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, 'pending'
          )`,
        )
        .run(
          id,
          input.dedupKey,
          input.contentHash,
          input.chatId,
          input.toolCallId ?? null,
          input.toolName,
          JSON.stringify(input.keysUsed),
          input.inferredLabel,
          input.contentDate,
          input.inferredSubject ?? null,
          capturedAt,
          input.body.length,
          input.body,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed")) {
        return null;
      }
      throw error;
    }

    return this.getById(id);
  }

  getById(id: string): ToolCaptureRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tool_captures WHERE id = ?`)
      .get(id) as ToolCaptureRow | undefined;
    return row ?? null;
  }

  markSynced(id: string, memoryId: string): void {
    this.db
      .prepare(
        `UPDATE tool_captures
         SET sync_status = 'synced',
             memory_id = ?,
             memory_synced_at = ?,
             sync_error = NULL
         WHERE id = ?`,
      )
      .run(memoryId, new Date().toISOString(), id);
  }

  markFailed(id: string, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE tool_captures
         SET sync_status = 'failed',
             sync_error = ?
         WHERE id = ?`,
      )
      .run(errorMessage.slice(0, 500), id);
  }

  close(): void {
    this.db.close();
  }
}

let ledgerInstance: ToolCaptureLedger | null = null;

export function getToolCaptureLedger(): ToolCaptureLedger {
  if (!ledgerInstance) {
    ledgerInstance = new ToolCaptureLedger();
  }
  return ledgerInstance;
}

/** Reset singleton after org/namespace workspace switch. */
export function resetToolCaptureLedgerForWorkspaceSwitch(): void {
  if (ledgerInstance) {
    ledgerInstance.close();
    ledgerInstance = null;
  }
}
