/**
 * Local Storage Provider
 *
 * SQLite-based storage for fast local caching and offline mode.
 * This is the foundation for all storage modes.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import type {
  IStorageProvider,
  StoredMessage,
  StoredSummary,
  ChatMetadata,
  ChatMemoryScope,
  ChatSummarySnapshot,
} from "./IStorageProvider";
import { ChatExporter } from "./ChatExporter.js";
import {
  deserializeEnhancedFields,
  formatSummaryForLLM,
  serializeEnhancedFields,
} from "./summaryFormatting.js";
import {
  computeContextEfficiencyStats,
  EMPTY_CONTEXT_EFFICIENCY_STATS,
} from "./contextEfficiencyStats.js";
import type { ContextEfficiencyStats } from "./contextEfficiencyStats.js";
import {
  invalidateChatFootprints,
  migrateFootprintColumns,
  scheduleContextFootprintBackfill,
  storeFootprintForNewMessage,
} from "./contextFootprintStore.js";
import {
  recordMessageTokensInCache,
  scheduleContextStatsRebuild,
} from "./contextStatsCache.js";
import {
  computeRecentMessageLimit,
  expandRecentMessageLimit,
  RECENT_MESSAGES_WITHOUT_SUMMARY,
  resolveSummaryBaseMessageCount,
} from "./recentMessageWindow.js";
import {
  getToolCountsByAgent,
  getToolCountsForAgent,
  getTotalToolInvocationsForAgent,
  sumToolInvocations,
} from "./agentToolCountsSql.js";
import {
  deleteChatSidecars,
  findOffloadRef,
  MAX_INLINE_PAYLOAD_BYTES,
  oversizedPayloadPlaceholder,
  readOffloadedResult,
  restoreSequencePayloads,
  serializeMessagePayloads,
} from "./messagePayloadStore.js";
import { startToolPayloadMigration } from "./toolPayloadMigration.js";

export class LocalStorageProvider implements IStorageProvider {
  private db!: Database.Database;
  private dbPath: string;
  private exporter: ChatExporter;
  private contextEfficiencyCache: {
    expiresAt: number;
    stats: ContextEfficiencyStats;
  } | null = null;
  private contextEfficiencyComputing = false;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, "chats.db");
    this.exporter = new ChatExporter();
  }

  /** Directory holding chats.db; offloaded tool payloads live alongside it. */
  private get dbDir(): string {
    return path.dirname(this.dbPath);
  }

  async initialize(): Promise<void> {
    await fs.ensureDir(path.dirname(this.dbPath));
    this.db = new Database(this.dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -10000");
    this.db.pragma("mmap_size = 30000000");
    this.db.pragma("temp_store = MEMORY");

    this.createSchema();
    await this.exporter.initialize();

    if (process.env.PAPR_DEBUG_STARTUP === "1") {
      console.log(`[LocalStorageProvider] Opened ${this.dbPath} (WAL, 10MB cache)`);
    }

    scheduleContextStatsRebuild(this.db);
    scheduleContextFootprintBackfill(this.db, {
      onBatchComplete: () => {
        this.contextEfficiencyCache = null;
      },
    });

    // Rows written before payload offloading existed keep two copies of every
    // tool payload and can be large enough to exhaust the heap when a chat is
    // opened. Compact them in the background rather than blocking startup.
    startToolPayloadMigration(this.db, this.dbDir);
  }

  private createSchema(): void {
    // Chats table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT,
        message_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        
        -- Summary fields (PAPR-compatible format)
        summary_short TEXT,
        summary_medium TEXT,
        summary_long TEXT,
        summary_topics TEXT,              -- JSON array
        summary_last_updated TEXT,
        summary_fetched_from_papr INTEGER DEFAULT 0,  -- Boolean: 0 or 1
        summary_last_fetched_at TEXT,
        summary_enhanced TEXT,            -- JSON: session_intent, key_decisions, etc.
        
        -- Sync tracking
        sync_status TEXT DEFAULT 'local', -- 'local' | 'synced' | 'papr_only'
        last_synced_at TEXT,
        papr_chat_id TEXT                 -- Parse Chat objectId
      )
    `);

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        
        -- Message content (aligned with CoreMessage)
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        
        -- Extended message metadata (for UI display)
        thinking TEXT,                    -- Reasoning/thinking text
        tool_calls TEXT,                  -- JSON array of tool calls
        error TEXT,                       -- Error message if any
        incomplete INTEGER DEFAULT 0,     -- 1 if message was interrupted/incomplete
        
        -- Model metadata
        model TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        
        -- Sync tracking
        sync_status TEXT DEFAULT 'local', -- 'local' | 'synced' | 'sync_pending' | 'sync_failed'
        papr_message_id TEXT,             -- Parse PostMessage objectId
        last_sync_attempt TEXT,
        sync_error TEXT,
        
        -- Agent attribution (for SubAgents participating in chats)
        source_agent_id TEXT DEFAULT 'main-agent',
        source_agent_name TEXT DEFAULT 'Paprwork Assistant',
        
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      )
    `);

    // Migrate existing databases: Add new columns if they don't exist
    // SQLite doesn't support "ALTER TABLE ADD COLUMN IF NOT EXISTS", so we check manually
    const columns = this.db.pragma("table_info(messages)") as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);

    console.log("[LocalStorage] Messages table columns:", columnNames);

    // Add thinking column if missing
    if (!columnNames.includes("thinking")) {
      console.log(
        '[LocalStorage] Adding "thinking" column to messages table...',
      );
      this.db.exec("ALTER TABLE messages ADD COLUMN thinking TEXT");
    }

    // Add tool_calls column if missing
    if (!columnNames.includes("tool_calls")) {
      console.log(
        '[LocalStorage] Adding "tool_calls" column to messages table...',
      );
      this.db.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT");
    }

    // Add error column if missing
    if (!columnNames.includes("error")) {
      console.log('[LocalStorage] Adding "error" column to messages table...');
      this.db.exec("ALTER TABLE messages ADD COLUMN error TEXT");
    }

    // Add incomplete column if missing
    if (!columnNames.includes("incomplete")) {
      console.log(
        '[LocalStorage] Adding "incomplete" column to messages table...',
      );
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN incomplete INTEGER DEFAULT 0",
      );
    }

    // Add source_agent_id column if missing
    if (!columnNames.includes("source_agent_id")) {
      console.log(
        '[LocalStorage] Adding "source_agent_id" column to messages table...',
      );
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN source_agent_id TEXT DEFAULT 'main-agent'",
      );
    }

    // Add source_agent_name column if missing
    if (!columnNames.includes("source_agent_name")) {
      console.log(
        '[LocalStorage] Adding "source_agent_name" column to messages table...',
      );
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN source_agent_name TEXT DEFAULT 'Paprwork Assistant'",
      );
    }

    // Add cost column if missing
    if (!columnNames.includes("cost")) {
      console.log('[LocalStorage] Adding "cost" column to messages table...');
      this.db.exec("ALTER TABLE messages ADD COLUMN cost REAL DEFAULT 0");
    }

    if (!columnNames.includes("cache_read_tokens")) {
      console.log(
        '[LocalStorage] Adding "cache_read_tokens" column to messages table...',
      );
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER DEFAULT 0",
      );
    }

    if (!columnNames.includes("cache_write_tokens")) {
      console.log(
        '[LocalStorage] Adding "cache_write_tokens" column to messages table...',
      );
      this.db.exec(
        "ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER DEFAULT 0",
      );
    }

    // Add sequence column if missing (V1-style interleaved text/tool sequence)
    if (!columnNames.includes("sequence")) {
      console.log(
        '[LocalStorage] Adding "sequence" column to messages table...',
      );
      this.db.exec("ALTER TABLE messages ADD COLUMN sequence TEXT"); // Store as JSON
    }

    if (!columnNames.includes("attachments")) {
      console.log(
        '[LocalStorage] Adding "attachments" column to messages table...',
      );
      this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
    }

    const chatColumns = this.db.pragma("table_info(chats)") as Array<{
      name: string;
    }>;
    const chatColumnNames = chatColumns.map((column) => column.name);
    if (!chatColumnNames.includes("summary_enhanced")) {
      console.log(
        '[LocalStorage] Adding "summary_enhanced" column to chats table...',
      );
      this.db.exec("ALTER TABLE chats ADD COLUMN summary_enhanced TEXT");
    }

    if (!chatColumnNames.includes("summary_base_message_count")) {
      console.log(
        '[LocalStorage] Adding "summary_base_message_count" column to chats table...',
      );
      this.db.exec(
        "ALTER TABLE chats ADD COLUMN summary_base_message_count INTEGER",
      );
      this.db.exec(
        `UPDATE chats
         SET summary_base_message_count = message_count
         WHERE summary_long IS NOT NULL
           AND summary_base_message_count IS NULL`,
      );
    }

    if (!chatColumnNames.includes("memory_scope")) {
      console.log(
        '[LocalStorage] Adding "memory_scope" column to chats table...',
      );
      this.db.exec(
        "ALTER TABLE chats ADD COLUMN memory_scope TEXT DEFAULT 'user'",
      );
    }

    migrateFootprintColumns(this.db);

    console.log("[LocalStorage] Database migration complete");

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_sync_status ON messages(chat_id, sync_status);
      CREATE INDEX IF NOT EXISTS idx_messages_unsynced ON messages(chat_id, sync_status) 
        WHERE sync_status IN ('sync_pending', 'sync_failed');
      CREATE INDEX IF NOT EXISTS idx_messages_assistant_timestamp ON messages(role, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_source_agent_role ON messages(source_agent_id, role);
    `);
  }

  // ===== Message Operations =====

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    // Ensure chat exists
    await this.ensureChatExists(chatId);

    const timestamp = message.timestamp || new Date().toISOString();
    
    // Estimate tokens for user messages if not provided
    // This ensures token_count accurately reflects context size for summarization
    let totalTokens = message.total_tokens || 0;
    let promptTokens = message.prompt_tokens || 0;
    let completionTokens = message.completion_tokens || 0;
    
    if (message.role === 'user' && totalTokens === 0) {
      // Estimate: 1 token ≈ 4 characters (rough but good enough for thresholds)
      const estimatedTokens = Math.ceil((message.content?.length || 0) / 4);
      totalTokens = estimatedTokens;
      promptTokens = estimatedTokens;
      console.log(`[LocalStorage] 📐 Estimated ${estimatedTokens} tokens for user message (${message.content?.length || 0} chars)`);
    }
    
    console.log(`[LocalStorage] 💾 Saving message to chat ${chatId}:`, {
      id: message.id,
      role: message.role,
      timestamp: timestamp,
      contentPreview: message.content?.substring(0, 50) + '...',
      total_tokens: totalTokens,
      hasThinking: !!message.thinking,
      hasToolCalls: !!message.toolCalls,
      hasAttachments: !!message.attachments?.length,
      hasError: !!message.error,
      incomplete: message.incomplete,
    });

    const messageId = message.id || uuidv4();

    // Offload oversized results and drop the payloads `sequence` duplicates
    // from `tool_calls`, so a single turn cannot write a multi-megabyte row.
    const payloads = serializeMessagePayloads({
      dbDir: this.dbDir,
      chatId,
      messageId,
      message,
    });

    // Insert message
    this.db
      .prepare(`
      INSERT INTO messages (
        id, chat_id, role, content, timestamp,
        thinking, tool_calls, error, incomplete,
        model, prompt_tokens, completion_tokens, total_tokens, cost,
        cache_read_tokens, cache_write_tokens,
        sync_status, papr_message_id,
        source_agent_id, source_agent_name,
        sequence, attachments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        messageId,
        chatId,
        message.role,
        message.content,
        timestamp,
        message.thinking || null,
        payloads.toolCallsJson,
        message.error || null,
        message.incomplete ? 1 : 0,
        message.model || null,
        promptTokens,
        completionTokens,
        totalTokens,
        message.cost || 0,
        message.cache_read_tokens || 0,
        message.cache_write_tokens || 0,
        message.sync_status || "local",
        message.papr_message_id || null,
        message.source_agent_id || "main-agent",
        message.source_agent_name || "Paprwork Assistant",
        payloads.sequenceJson,
        message.attachments?.length
          ? JSON.stringify(message.attachments)
          : null,
      );

    // Update chat message count and updated_at
    const updateResult = this.db
      .prepare(`
      UPDATE chats 
      SET message_count = message_count + 1,
          updated_at = ?
      WHERE id = ?
    `)
      .run(new Date().toISOString(), chatId);
    
    // Verify the update worked
    const updatedChat = this.db
      .prepare(`SELECT id, message_count FROM chats WHERE id = ?`)
      .get(chatId) as { id: string; message_count: number } | undefined;
    
    if (message.role === "assistant" && promptTokens > 0) {
      recordMessageTokensInCache(
        this.db,
        chatId,
        message.role,
        promptTokens,
        completionTokens,
        totalTokens,
      );
      storeFootprintForNewMessage(this.db, chatId, messageId, promptTokens);
      this.contextEfficiencyCache = null;
    } else if (totalTokens > 0) {
      recordMessageTokensInCache(
        this.db,
        chatId,
        message.role,
        promptTokens,
        completionTokens,
        totalTokens,
      );
    }

    console.log(`[LocalStorage] ✅ Message saved successfully`);
    console.log(`[LocalStorage] 📊 Chat stats after save: message_count=${updatedChat?.message_count || 0} (changes=${updateResult.changes})`);
  }

  async updateMessage(
    chatId: string,
    messageId: string,
    message: StoredMessage,
  ): Promise<void> {
    const timestamp = message.timestamp || new Date().toISOString();

    let totalTokens = message.total_tokens || 0;
    let promptTokens = message.prompt_tokens || 0;
    let completionTokens = message.completion_tokens || 0;

    if (message.role === "user" && totalTokens === 0) {
      const estimatedTokens = Math.ceil((message.content?.length || 0) / 4);
      totalTokens = estimatedTokens;
      promptTokens = estimatedTokens;
    }

    const payloads = serializeMessagePayloads({
      dbDir: this.dbDir,
      chatId,
      messageId,
      message,
    });

    this.db
      .prepare(`
      UPDATE messages SET
        role = ?,
        content = ?,
        timestamp = ?,
        thinking = ?,
        tool_calls = ?,
        error = ?,
        incomplete = ?,
        model = ?,
        prompt_tokens = ?,
        completion_tokens = ?,
        total_tokens = ?,
        cost = ?,
        cache_read_tokens = ?,
        cache_write_tokens = ?,
        sync_status = ?,
        papr_message_id = ?,
        source_agent_id = ?,
        source_agent_name = ?,
        sequence = ?
      WHERE id = ? AND chat_id = ?
    `)
      .run(
        message.role,
        message.content,
        timestamp,
        message.thinking || null,
        payloads.toolCallsJson,
        message.error || null,
        message.incomplete ? 1 : 0,
        message.model || null,
        promptTokens,
        completionTokens,
        totalTokens,
        message.cost || 0,
        message.cache_read_tokens || 0,
        message.cache_write_tokens || 0,
        message.sync_status || "local",
        message.papr_message_id || null,
        message.source_agent_id || "main-agent",
        message.source_agent_name || "Paprwork Assistant",
        payloads.sequenceJson,
        messageId,
        chatId,
      );

    this.db
      .prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), chatId);
  }

  /**
   * Update the stored delegate_task tool result when a background delegation finishes.
   * Keeps chat history in sync with live job status (UI already uses WebSocket updates).
   */
  patchDelegateTaskToolResult(
    chatId: string,
    delegationRunId: string,
    update: {
      status: "completed" | "failed";
      resultText?: string;
      error?: string;
      completedAt?: string;
    },
  ): boolean {
    interface ToolCallRow {
      id: string;
      name?: string;
      toolName?: string;
      result?: string;
      args?: Record<string, unknown>;
      status?: string;
    }

    // `sequence` points at `tool_calls` for its payloads, so patching here is
    // enough for both the LLM history and the UI.
    const rows = this.db
      .prepare(
        // Skipping oversized rows costs nothing in practice: a live turn's
        // payloads are capped on write, and legacy rows shrink once the
        // backfill reaches them. Parsing one here would risk the heap.
        `SELECT id, tool_calls FROM messages
         WHERE chat_id = ? AND role = 'assistant'
           AND tool_calls IS NOT NULL AND tool_calls != ''
           AND LENGTH(tool_calls) <= ${MAX_INLINE_PAYLOAD_BYTES}
         ORDER BY timestamp DESC`,
      )
      .all(chatId) as Array<{ id: string; tool_calls: string }>;

    for (const row of rows) {
      let toolCalls: ToolCallRow[];
      try {
        toolCalls = JSON.parse(row.tool_calls) as ToolCallRow[];
      } catch {
        continue;
      }

      let patched = false;
      for (const tc of toolCalls) {
        const toolName = tc.name ?? tc.toolName;
        if (toolName !== "delegate_task") continue;

        let parsed: Record<string, unknown>;
        try {
          parsed =
            typeof tc.result === "string"
              ? (JSON.parse(tc.result) as Record<string, unknown>)
              : ((tc.result as Record<string, unknown> | undefined) ?? {});
        } catch {
          continue;
        }

        const data =
          (parsed.data as Record<string, unknown> | undefined) ?? parsed;
        const runId =
          (data.id as string | undefined) ??
          (data.jobId as string | undefined) ??
          (data.delegationId as string | undefined);
        if (runId !== delegationRunId) continue;

        const updatedData: Record<string, unknown> = {
          ...data,
          status: update.status,
          completedAt: update.completedAt ?? new Date().toISOString(),
        };
        if (update.resultText !== undefined) {
          updatedData.resultText = update.resultText;
        }
        if (update.error !== undefined) {
          updatedData.error = update.error;
        }

        const updatedResult =
          parsed.data !== undefined
            ? { ...parsed, data: updatedData }
            : updatedData;

        tc.result = JSON.stringify(updatedResult);
        tc.status = update.status === "failed" ? "error" : "success";
        patched = true;
        break;
      }

      if (patched) {
        this.db
          .prepare(`UPDATE messages SET tool_calls = ? WHERE id = ?`)
          .run(JSON.stringify(toolCalls), row.id);
        console.log(
          `[LocalStorage] Patched delegate_task result for run ${delegationRunId} in chat ${chatId}`,
        );
        return true;
      }
    }

    return false;
  }

  async loadMessages(
    chatId: string,
    limit?: number,
    skip?: number,
  ): Promise<StoredMessage[]> {
    // When limit is specified, we load most recent messages first (DESC), then reverse
    // to maintain chronological order in the UI
    // The payload columns are left in SQLite when they exceed the read limit, so
    // one oversized legacy row can no longer pull hundreds of megabytes into the
    // heap. LENGTH() still comes back, which is how the mapper reports the skip.
    let query = `
      SELECT 
        id, chat_id, role, content, timestamp,
        thinking, error, incomplete,
        model, prompt_tokens, completion_tokens, total_tokens,
        sync_status, papr_message_id, last_sync_attempt, sync_error,
        source_agent_id, source_agent_name,
        attachments,
        CASE WHEN LENGTH(tool_calls) > ${MAX_INLINE_PAYLOAD_BYTES}
             THEN NULL ELSE tool_calls END AS tool_calls,
        LENGTH(tool_calls) AS tool_calls_bytes,
        CASE WHEN LENGTH(sequence) > ${MAX_INLINE_PAYLOAD_BYTES}
             THEN NULL ELSE sequence END AS sequence,
        LENGTH(sequence) AS sequence_bytes
      FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ${limit ? 'DESC' : 'ASC'}
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    if (skip) {
      query += ` OFFSET ${skip}`;
    }

    const rows = this.db.prepare(query).all(chatId) as any[];

    // If using pagination (limit specified), reverse to get chronological order
    const orderedRows = limit ? rows.reverse() : rows;

    console.log(
      `[LocalStorage] Loaded ${orderedRows.length} messages for chat ${chatId}${limit ? ` (limit: ${limit}, skip: ${skip || 0})` : ''}`,
    );
    orderedRows.forEach((row, i) => {
      console.log(
        `  Message ${i}: role=${row.role}, hasThinking=${!!row.thinking}, hasToolCalls=${!!row.tool_calls}`,
      );
    });

    return orderedRows.map((row) => {
      const toolCalls = this.parsePayloadColumn<StoredMessage["toolCalls"]>(
        row,
        "tool_calls",
      );

      return {
      id: row.id,
      chat_id: row.chat_id,
      role: row.role as "user" | "assistant",
      content: row.content,
      timestamp: row.timestamp,
      thinking: row.thinking || undefined,
      toolCalls,
      // `sequence` stores pointers into `tool_calls` rather than a second copy
      // of every payload; rebuild them so consumers see the original shape.
      sequence: restoreSequencePayloads(
        this.parsePayloadColumn<StoredMessage["sequence"]>(row, "sequence"),
        toolCalls,
      ),
      error: row.error || undefined,
      incomplete: row.incomplete === 1,
      model: row.model,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
      cache_read_tokens: row.cache_read_tokens ?? undefined,
      cache_write_tokens: row.cache_write_tokens ?? undefined,
      cost: row.cost,
      sync_status: row.sync_status as any,
      papr_message_id: row.papr_message_id,
      last_sync_attempt: row.last_sync_attempt,
      sync_error: row.sync_error,
      source_agent_id: row.source_agent_id || "main-agent",
      source_agent_name: row.source_agent_name || "Paprwork Assistant",
      attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
      };
    });
  }

  /**
   * Parse one of the JSON payload columns.
   *
   * The query nulls out columns above MAX_INLINE_PAYLOAD_BYTES, so an oversized
   * legacy row arrives here with only its length. Those are skipped rather than
   * parsed — a single 100MB+ row was enough to abort the gateway on OOM. The
   * offload migration rewrites them into sidecar files.
   */
  private parsePayloadColumn<T>(
    row: { id: string; [key: string]: any },
    column: "tool_calls" | "sequence",
  ): T | undefined {
    const raw = row[column];
    const bytes = row[`${column}_bytes`] as number | null;

    if (typeof raw !== "string" || raw.length === 0) {
      if (bytes && bytes > MAX_INLINE_PAYLOAD_BYTES) {
        console.warn(
          `[LocalStorage] Skipped ${row.id} ${oversizedPayloadPlaceholder({ column, bytes })}`,
        );
      }
      return undefined;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      console.warn(
        `[LocalStorage] Malformed ${column} on message ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // Get chat metadata
    const chat = this.db
      .prepare(`
      SELECT id, title, message_count, 
             summary_short, summary_medium, summary_long, summary_topics,
             summary_enhanced, summary_base_message_count
      FROM chats 
      WHERE id = ?
    `)
      .get(chatId) as any;

    if (!chat) {
      return [];
    }

    console.log(`[LocalStorage] 📥 loadMessagesForLLM called for chat ${chatId}`);
    console.log(`[LocalStorage] 📊 Chat metadata: message_count=${chat.message_count}, has_summary=${!!chat.summary_long}`);

    // If no summary, return all messages with toolCalls intact
    // IMPORTANT: Pass toolCalls as a separate field so historyFormatter
    // can produce proper AI SDK structured messages (not [tool_activity] text)
    if (!chat.summary_long) {
      console.log(`[LocalStorage] 🔀 Taking NO SUMMARY path`);
      const messages = await this.loadMessages(chatId);
      console.log(`[LocalStorage] ✅ No summary - returning all ${messages.length} messages`);
      
      // Log first and last messages with timestamps to verify order
      if (messages.length > 0) {
        console.log(`[LocalStorage] 🔍 First message: [${messages[0].timestamp}] ${messages[0].role}`);
        console.log(`[LocalStorage] 🔍 Last message: [${messages[messages.length - 1].timestamp}] ${messages[messages.length - 1].role}`);
      }
      
      return messages.map((message) => ({
        role: message.role,
        content: message.content,
        thinking: message.thinking,
        toolCalls: message.toolCalls,
        timestamp: message.timestamp,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      }));
    }

    console.log(`[LocalStorage] 🔀 Taking WITH SUMMARY path`);

    // Get recent messages AFTER summary (chunked 20→40 window for cache-friendly growth)
    const summaryBase = resolveSummaryBaseMessageCount(
      chat.message_count,
      chat.summary_base_message_count as number | null,
    );
    let recentMessageLimit = chat.summary_long
      ? computeRecentMessageLimit(chat.message_count, summaryBase)
      : RECENT_MESSAGES_WITHOUT_SUMMARY;

    console.log(
      `[LocalStorage] 🔎 Summary exists - querying for ${recentMessageLimit} most recent messages (base=${summaryBase})...`,
    );

    let recentMessages = this.db
      .prepare(`
      SELECT id, role, content, thinking, timestamp, attachments,
             CASE WHEN LENGTH(tool_calls) > ${MAX_INLINE_PAYLOAD_BYTES}
                  THEN NULL ELSE tool_calls END AS tool_calls,
             LENGTH(tool_calls) AS tool_calls_bytes
      FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `)
      .all(chatId, recentMessageLimit) as any[];

    // Reverse to chronological order before checking oldest role
    recentMessages.reverse();

    const expandedLimit = expandRecentMessageLimit(
      chat.message_count,
      recentMessageLimit,
      recentMessages[0]?.role,
    );
    if (expandedLimit > recentMessageLimit) {
      console.log(
        `[LocalStorage] ↗ Expanded recent window ${recentMessageLimit}→${expandedLimit} (avoid mid-turn cut)`,
      );
      recentMessageLimit = expandedLimit;
      recentMessages = this.db
        .prepare(`
        SELECT id, role, content, thinking, timestamp, attachments,
               CASE WHEN LENGTH(tool_calls) > ${MAX_INLINE_PAYLOAD_BYTES}
                    THEN NULL ELSE tool_calls END AS tool_calls,
               LENGTH(tool_calls) AS tool_calls_bytes
        FROM messages 
        WHERE chat_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `)
        .all(chatId, recentMessageLimit) as any[];
      recentMessages.reverse();
    }
    // Log what we actually got
    console.log(`[LocalStorage] 🔍 Query returned ${recentMessages.length} messages (chronological):`);
    recentMessages.forEach((msg, i) => {
      const preview = typeof msg.content === 'string' ? msg.content.substring(0, 50) : '';
      console.log(`  ${i}. [${msg.timestamp}] ${msg.role}: "${preview}..."`);
    });

    const archivedCount = chat.message_count - recentMessages.length;
    const enhanced = deserializeEnhancedFields(chat.summary_enhanced);

    console.log(`[LocalStorage] Loading LLM context for chat ${chatId}:`);
    console.log(`  Total messages in DB: ${chat.message_count}`);
    console.log(`  Archived (in summary): ${archivedCount}`);
    console.log(`  Recent (loaded): ${recentMessages.length}`);
    console.log(`  Summary exists: ${!!chat.summary_long}`);
    console.log(`  Recent message limit: ${recentMessageLimit}`);

    const topics = chat.summary_topics ? JSON.parse(chat.summary_topics) : [];
    const messages = await this.loadMessages(chatId);
    const chatFilePath = await this.exporter.exportChat(
      chatId,
      chat.title,
      messages,
    );

    // Build summary for injection as user message
    const summaryForSystemPrompt = formatSummaryForLLM({
      tiers: {
        short_term: chat.summary_short,
        medium_term: chat.summary_medium,
        long_term: chat.summary_long,
        topics,
        last_updated: chat.summary_last_updated ?? new Date().toISOString(),
      },
      enhanced,
      chatFilePath,
    });

    // Format recent messages — pass toolCalls through for structured AI SDK format
    const formattedRecent = recentMessages.map((message) => {
      const parsedToolCalls = this.parsePayloadColumn<unknown[]>(
        message,
        "tool_calls",
      );
      const parsedAttachments =
        typeof message.attachments === "string" && message.attachments.length > 0
          ? (JSON.parse(message.attachments) as unknown[])
          : undefined;

      return {
        role: typeof message.role === "string" ? message.role : "assistant",
        content: typeof message.content === "string" ? message.content : "",
        thinking:
          typeof message.thinking === "string" ? message.thinking : undefined,
        toolCalls: parsedToolCalls,
        timestamp: message.timestamp,
        ...(Array.isArray(parsedAttachments) && parsedAttachments.length > 0
          ? { attachments: parsedAttachments }
          : {}),
      };
    });

    // Inject summary as special __summary property for AgentService to extract
    return [{ __summary: summaryForSystemPrompt }, ...formattedRecent];
  }

  // ===== Summary Operations =====

  async fetchAndCacheSummary(chatId: string): Promise<StoredSummary | null> {
    // Local-only mode: would need to generate with LLM
    // For now, return null (will be implemented with LLMClient)
    const messages = await this.loadMessages(chatId);

    if (messages.length < 50) {
      return null; // Not enough messages for summary
    }

    // TODO: Implement local LLM summarization
    // For now, return a placeholder
    return null;
  }

  async getSummary(chatId: string): Promise<StoredSummary | null> {
    const chat = this.db
      .prepare(`
      SELECT summary_short, summary_medium, summary_long, 
             summary_topics, summary_last_updated,
             summary_fetched_from_papr, summary_last_fetched_at,
             summary_enhanced
      FROM chats 
      WHERE id = ?
    `)
      .get(chatId) as any;

    if (!chat || !chat.summary_long) {
      return null;
    }

    return {
      short_term: chat.summary_short,
      medium_term: chat.summary_medium,
      long_term: chat.summary_long,
      topics: chat.summary_topics ? JSON.parse(chat.summary_topics) : [],
      last_updated: chat.summary_last_updated,
      enhanced: deserializeEnhancedFields(chat.summary_enhanced),
      fetched_from_papr: chat.summary_fetched_from_papr === 1,
      last_fetched_at: chat.summary_last_fetched_at,
    };
  }

  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    const chatRow = this.db
      .prepare(
        "SELECT message_count, summary_long, summary_base_message_count FROM chats WHERE id = ?",
      )
      .get(chatId) as
      | {
          message_count: number;
          summary_long: string | null;
          summary_base_message_count: number | null;
        }
      | undefined;
    const messageCount = chatRow?.message_count ?? 0;
    const hadSummary = Boolean(chatRow?.summary_long);
    const existingBase = chatRow?.summary_base_message_count ?? null;

    // First summary: anchor at current count (window starts at MIN).
    // Re-summarize: preserve current window depth so we don't snap to MIN and drop recent turns.
    let summaryBaseMessageCount = messageCount;
    if (hadSummary && existingBase != null) {
      const preservedWindow = computeRecentMessageLimit(
        messageCount,
        existingBase,
      );
      summaryBaseMessageCount = Math.max(0, messageCount - preservedWindow);
    }

    this.db
      .prepare(`
      UPDATE chats 
      SET summary_short = ?,
          summary_medium = ?,
          summary_long = ?,
          summary_topics = ?,
          summary_last_updated = ?,
          summary_fetched_from_papr = ?,
          summary_last_fetched_at = ?,
          summary_enhanced = ?,
          summary_base_message_count = ?
      WHERE id = ?
    `)
      .run(
        summary.short_term,
        summary.medium_term,
        summary.long_term,
        JSON.stringify(summary.topics),
        summary.last_updated,
        summary.fetched_from_papr ? 1 : 0,
        summary.last_fetched_at || null,
        serializeEnhancedFields(summary.enhanced),
        summaryBaseMessageCount,
        chatId,
      );

    invalidateChatFootprints(this.db, chatId);
    this.contextEfficiencyCache = null;
    scheduleContextFootprintBackfill(this.db, {
      onBatchComplete: () => {
        this.contextEfficiencyCache = null;
      },
    });
  }

  // ===== Chat Operations =====

  async createChat(chatId: string, title?: string): Promise<void> {
    const now = new Date().toISOString();

    this.db
      .prepare(`
      INSERT OR IGNORE INTO chats (id, title, message_count, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `)
      .run(chatId, title || null, now, now);
  }

  async updateChat(
    chatId: string,
    updates: Partial<{ title: string; memory_scope: ChatMemoryScope }>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: Array<string> = [];

    if (updates.title !== undefined) {
      sets.push("title = ?");
      values.push(updates.title);
    }
    if (updates.memory_scope !== undefined) {
      sets.push("memory_scope = ?");
      values.push(updates.memory_scope);
    }

    if (sets.length === 0) {
      return;
    }

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(chatId);

    this.db
      .prepare(
        `
        UPDATE chats
        SET ${sets.join(", ")}
        WHERE id = ?
      `,
      )
      .run(...values);
  }

  async deleteChat(chatId: string): Promise<void> {
    // Foreign key cascade will delete messages
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    deleteChatSidecars(this.dbDir, chatId);
  }

  /**
   * Read the full text of a tool result that was moved to sidecar storage.
   * Returns null when this tool call kept its result inline.
   */
  async readOffloadedToolResult(
    chatId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT tool_calls FROM messages
         WHERE id = ? AND chat_id = ?
           AND LENGTH(tool_calls) <= ${MAX_INLINE_PAYLOAD_BYTES}`,
      )
      .get(messageId, chatId) as { tool_calls: string | null } | undefined;

    if (!row?.tool_calls) return null;

    let toolCalls: StoredMessage["toolCalls"];
    try {
      toolCalls = JSON.parse(row.tool_calls);
    } catch {
      return null;
    }

    const ref = findOffloadRef({ toolCalls } as StoredMessage, toolCallId);
    return ref ? readOffloadedResult(this.dbDir, ref) : null;
  }

  async listChats(): Promise<ChatMetadata[]> {
    const rows = this.db
      .prepare(`
      SELECT id, title, message_count, created_at as createdAt, updated_at as updatedAt, last_synced_at, memory_scope
      FROM chats 
      ORDER BY updated_at DESC
    `)
      .all() as any[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title || row.id,
      message_count: row.message_count,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      last_synced_at: row.last_synced_at,
      memory_scope: row.memory_scope as ChatMemoryScope | undefined,
    }));
  }

  async listRecentChatSummaries(
    limit: number,
    maxAgeDays: number,
  ): Promise<ChatSummarySnapshot[]> {
    const rows = this.db
      .prepare(
        `
      SELECT id, title, message_count, updated_at as updatedAt,
             summary_short, summary_medium, summary_topics
      FROM chats
      WHERE summary_short IS NOT NULL AND trim(summary_short) != ''
        AND updated_at >= datetime('now', ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(`-${maxAgeDays} days`, limit) as Array<{
      id: string;
      title: string | null;
      message_count: number;
      updatedAt: string;
      summary_short: string | null;
      summary_medium: string | null;
      summary_topics: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      title: row.title || row.id,
      updated_at: row.updatedAt,
      message_count: row.message_count,
      summary_short: row.summary_short,
      summary_medium: row.summary_medium,
      summary_topics: row.summary_topics
        ? (JSON.parse(row.summary_topics) as string[])
        : [],
    }));
  }

  async getChat(chatId: string): Promise<ChatMetadata | null> {
    const row = this.db
      .prepare(`
      SELECT id, title, message_count, created_at as createdAt, updated_at as updatedAt, last_synced_at, memory_scope
      FROM chats 
      WHERE id = ?
    `)
      .get(chatId) as any;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      title: row.title || row.id,
      message_count: row.message_count,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      last_synced_at: row.last_synced_at,
      memory_scope: row.memory_scope as ChatMemoryScope | undefined,
    };
  }

  // ===== Sync Operations =====

  async markMessageSynced(
    messageId: string,
    paprObjectId: string,
  ): Promise<void> {
    this.db
      .prepare(`
      UPDATE messages 
      SET sync_status = 'synced',
          papr_message_id = ?,
          sync_error = NULL
      WHERE id = ?
    `)
      .run(paprObjectId, messageId);
  }

  async markSyncFailed(messageId: string, error: string): Promise<void> {
    this.db
      .prepare(`
      UPDATE messages 
      SET sync_status = 'sync_failed',
          last_sync_attempt = ?,
          sync_error = ?
      WHERE id = ?
    `)
      .run(new Date().toISOString(), error, messageId);
  }

  async getChatSyncStats(chatId: string): Promise<{
    total: number;
    synced: number;
    sync_pending: number;
    sync_failed: number;
    local: number;
    papr_only: number;
    recentFailures: Array<{
      messageId: string;
      error: string;
      timestamp: string;
    }>;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT sync_status, COUNT(*) as count
      FROM messages
      WHERE chat_id = ?
      GROUP BY sync_status
    `,
      )
      .all(chatId) as Array<{ sync_status: string; count: number }>;

    const stats = {
      total: 0,
      synced: 0,
      sync_pending: 0,
      sync_failed: 0,
      local: 0,
      papr_only: 0,
    };

    for (const row of rows) {
      stats.total += row.count;
      if (row.sync_status in stats) {
        stats[row.sync_status as keyof typeof stats] = row.count;
      }
    }

    const failureRows = this.db
      .prepare(
        `
      SELECT id, sync_error, timestamp
      FROM messages
      WHERE chat_id = ?
        AND sync_status = 'sync_failed'
        AND sync_error IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 3
    `,
      )
      .all(chatId) as Array<{
      id: string;
      sync_error: string;
      timestamp: string;
    }>;

    return {
      ...stats,
      recentFailures: failureRows.map((row) => ({
        messageId: row.id,
        error: row.sync_error,
        timestamp: row.timestamp,
      })),
    };
  }

  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    // Named columns, not SELECT *: the payload columns are not part of the
    // result and pulling them in only to drop them can exhaust the heap.
    const rows = this.db
      .prepare(`
      SELECT id, chat_id, role, content, timestamp, model,
             prompt_tokens, completion_tokens, total_tokens,
             sync_status, papr_message_id, last_sync_attempt, sync_error
      FROM messages 
      WHERE chat_id = ? 
        AND sync_status IN ('sync_pending', 'sync_failed')
      ORDER BY timestamp ASC
    `)
      .all(chatId) as any[];

    return rows.map((row) => ({
      id: row.id,
      chat_id: row.chat_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      model: row.model,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
      sync_status: row.sync_status,
      papr_message_id: row.papr_message_id,
      last_sync_attempt: row.last_sync_attempt,
      sync_error: row.sync_error,
    }));
  }

  async getChatStats(chatId: string): Promise<{
    message_count: number;
    token_count: number;
    cost_total: number;
    has_summary: boolean;
  }> {
    const chat = this.db
      .prepare(`
      SELECT message_count, summary_long FROM chats WHERE id = ?
    `)
      .get(chatId) as any;

    if (!chat) {
      return {
        message_count: 0,
        token_count: 0,
        cost_total: 0,
        has_summary: false,
      };
    }

    // Get token and cost stats from database
    const tokenStats = this.db
      .prepare(
        `SELECT 
          COALESCE(SUM(total_tokens), 0) as token_count,
          COALESCE(SUM(cost), 0) as cost_total,
          COUNT(*) as messages_with_tokens
        FROM messages 
        WHERE chat_id = ? AND total_tokens > 0`,
      )
      .get(chatId) as any;

    console.log(`[LocalStorage] 📊 getChatStats for ${chatId}:`, {
      message_count: chat.message_count,
      token_count: tokenStats?.token_count || 0,
      messages_with_tokens: tokenStats?.messages_with_tokens || 0,
      has_summary: !!chat.summary_long,
    });

    return {
      message_count: chat.message_count,
      token_count: tokenStats?.token_count || 0,
      cost_total: tokenStats?.cost_total || 0,
      has_summary: !!chat.summary_long,
    };
  }

  async getChatCost(chatId: string): Promise<{
    total: number;
    byModel: Record<string, number>;
    messageCount: number;
    avgCostPerMessage: number;
  }> {
    // Get total cost and message count
    const totals = this.db
      .prepare(
        `SELECT 
          COALESCE(SUM(cost), 0) as total,
          COUNT(*) as count
        FROM messages 
        WHERE chat_id = ? AND role = 'assistant'`,
      )
      .get(chatId) as any;

    // Get cost by model
    const byModelRows = this.db
      .prepare(
        `SELECT 
          model,
          COALESCE(SUM(cost), 0) as cost
        FROM messages 
        WHERE chat_id = ? AND role = 'assistant' AND model IS NOT NULL
        GROUP BY model`,
      )
      .all(chatId) as any[];

    const byModel: Record<string, number> = {};
    for (const row of byModelRows) {
      byModel[row.model] = row.cost;
    }

    const total = totals?.total || 0;
    const messageCount = totals?.count || 0;

    return {
      total,
      byModel,
      messageCount,
      avgCostPerMessage: messageCount > 0 ? total / messageCount : 0,
    };
  }

  async getGlobalCostStats(): Promise<{
    today: number;
    thisWeek: number;
    thisMonth: number;
    total: number;
    totalTokens: number;
    todayTokens: number;
    thisWeekTokens: number;
    thisMonthTokens: number;
    totalMessages: number;
    topModels: Array<{
      model: string;
      cost: number;
      tokens: number;
      count: number;
    }>;
  }> {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).toISOString();
    const weekStart = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).toISOString();

    const totalStats = this.db
      .prepare(
        `SELECT 
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
          COUNT(*) as count,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END), 0) as today_cost,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END), 0) as week_cost,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END), 0) as month_cost,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as today_tokens,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as week_tokens,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as month_tokens
        FROM messages 
        WHERE role = 'assistant'`,
      )
      .get(
        todayStart,
        weekStart,
        monthStart,
        todayStart,
        weekStart,
        monthStart,
      ) as {
      cost: number;
      total_tokens: number;
      count: number;
      today_cost: number;
      week_cost: number;
      month_cost: number;
      today_tokens: number;
      week_tokens: number;
      month_tokens: number;
    };

    const topModelsRows = this.db
      .prepare(
        `SELECT 
          model,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
          COUNT(*) as count
        FROM messages 
        WHERE role = 'assistant' AND model IS NOT NULL
        GROUP BY model
        ORDER BY cost DESC
        LIMIT 20`,
      )
      .all() as Array<{
      model: string;
      cost: number;
      tokens: number;
      count: number;
    }>;

    return {
      today: totalStats?.today_cost || 0,
      thisWeek: totalStats?.week_cost || 0,
      thisMonth: totalStats?.month_cost || 0,
      total: totalStats?.cost || 0,
      totalTokens: totalStats?.total_tokens || 0,
      todayTokens: totalStats?.today_tokens || 0,
      thisWeekTokens: totalStats?.week_tokens || 0,
      thisMonthTokens: totalStats?.month_tokens || 0,
      totalMessages: totalStats?.count || 0,
      topModels: topModelsRows.map((row) => ({
        model: row.model,
        cost: row.cost,
        tokens: row.tokens,
        count: row.count,
      })),
    };
  }

  /**
   * Get daily cost trends for the last N days
   */
  async getDailyCostTrends(
    days: number = 30,
  ): Promise<
    Array<{ date: string; cost: number; messages: number; tokens: number }>
  > {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString();

    const dailyStats = this.db
      .prepare(
        `SELECT
          DATE(timestamp) as date,
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
          COUNT(*) as messages
        FROM messages
        WHERE role = 'assistant' AND timestamp >= ?
        GROUP BY DATE(timestamp)
        ORDER BY date ASC`,
      )
      .all(startDateStr) as Array<{
      date: string;
      cost: number;
      tokens: number;
      messages: number;
    }>;

    return dailyStats.map((row) => ({
      date: row.date,
      cost: row.cost,
      messages: row.messages,
      tokens: row.tokens,
    }));
  }

  /**
   * Get model usage distribution (for pie chart)
   */
  async getModelDistribution(): Promise<
    Array<{ model: string; percentage: number; cost: number; messages: number }>
  > {
    const totalStats = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) as total_cost
        FROM messages
        WHERE role = 'assistant'`,
      )
      .get() as any;

    const totalCost = totalStats?.total_cost || 0;

    if (totalCost === 0) {
      return [];
    }

    const modelStats = this.db
      .prepare(
        `SELECT
          model,
          COALESCE(SUM(cost), 0) as cost,
          COUNT(*) as messages
        FROM messages
        WHERE role = 'assistant' AND model IS NOT NULL
        GROUP BY model
        ORDER BY cost DESC`,
      )
      .all() as any[];

    return modelStats.map((row) => ({
      model: row.model,
      percentage: (row.cost / totalCost) * 100,
      cost: row.cost,
      messages: row.messages,
    }));
  }

  /**
   * Get per-agent statistics
   */
  async getAgentStats(agentId: string): Promise<{
    totalMessages: number;
    totalTokens: number;
    totalCost: number;
    toolCallsCount: number;
    totalToolInvocations?: number;
    avgTokensPerMessage: number;
    avgCostPerMessage: number;
    mostUsedTools: Array<{ tool: string; count: number }>;
  }> {
    // Get basic stats
    const stats = this.db
      .prepare(
        `SELECT
          COUNT(*) as message_count,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(CASE WHEN tool_calls IS NOT NULL AND tool_calls != '' THEN 1 ELSE 0 END), 0) as tool_calls_count
        FROM messages
        WHERE COALESCE(source_agent_id, 'main-agent') = ? AND role = 'assistant'`,
      )
      .get(agentId) as {
      message_count: number;
      total_tokens: number;
      total_cost: number;
      tool_calls_count: number;
    };

    const messageCount = stats?.message_count || 0;
    const totalTokens = stats?.total_tokens || 0;
    const totalCost = stats?.total_cost || 0;
    const toolCallsCount = stats?.tool_calls_count || 0;

    const mostUsedTools = getToolCountsForAgent(this.db, agentId).slice(0, 5);
    const totalToolInvocations = getTotalToolInvocationsForAgent(
      this.db,
      agentId,
    );

    return {
      totalMessages: messageCount,
      totalTokens,
      totalCost,
      toolCallsCount,
      totalToolInvocations,
      avgTokensPerMessage: messageCount > 0 ? totalTokens / messageCount : 0,
      avgCostPerMessage: messageCount > 0 ? totalCost / messageCount : 0,
      mostUsedTools,
    };
  }

  async getAllAgentStats(): Promise<
    Record<
      string,
      {
        totalMessages: number;
        totalTokens: number;
        totalCost: number;
        toolCallsCount: number;
        avgTokensPerMessage: number;
        avgCostPerMessage: number;
        mostUsedTools: Array<{ tool: string; count: number }>;
      }
    >
  > {
    const aggregateRows = this.db
      .prepare(
        `SELECT
          source_agent_id as agent_id,
          COUNT(*) as message_count,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(CASE WHEN tool_calls IS NOT NULL AND tool_calls != '' THEN 1 ELSE 0 END), 0) as tool_calls_count
        FROM messages
        WHERE role = 'assistant'
        GROUP BY source_agent_id`,
      )
      .all() as Array<{
      agent_id: string;
      message_count: number;
      total_tokens: number;
      total_cost: number;
      tool_calls_count: number;
    }>;

    const toolCountsByAgent = getToolCountsByAgent(this.db);

    const result: Record<
      string,
      {
        totalMessages: number;
        totalTokens: number;
        totalCost: number;
        toolCallsCount: number;
        totalToolInvocations?: number;
        avgTokensPerMessage: number;
        avgCostPerMessage: number;
        mostUsedTools: Array<{ tool: string; count: number }>;
      }
    > = {};

    for (const row of aggregateRows) {
      const agentId = row.agent_id || "main-agent";
      const messageCount = row.message_count || 0;
      const totalTokens = row.total_tokens || 0;
      const totalCost = row.total_cost || 0;
      const toolCallsCount = row.tool_calls_count || 0;
      const agentTools = toolCountsByAgent.get(agentId) ?? [];
      result[agentId] = {
        totalMessages: messageCount,
        totalTokens,
        totalCost,
        toolCallsCount,
        totalToolInvocations: sumToolInvocations(agentTools),
        avgTokensPerMessage: messageCount > 0 ? totalTokens / messageCount : 0,
        avgCostPerMessage: messageCount > 0 ? totalCost / messageCount : 0,
        mostUsedTools: agentTools.slice(0, 5),
      };
    }

    return result;
  }

  async getAgentOutputs(agentId?: string): Promise<{
    documents: Array<{ id: string; title: string; createdAt: string }>;
    apps: Array<{ id: string; title: string; createdAt: string }>;
    plans: Array<{ planId: string; title: string; createdAt: string }>;
  }> {
    // Import services
    const { getDocumentService } = await import("../DocumentService.js");
    const { getAppService } = await import("../AppService.js");

    const documentService = getDocumentService();
    const appService = getAppService();

    // Get documents
    const allDocsMeta = await documentService.listDocuments();
    const documents = agentId
      ? allDocsMeta
          .filter((doc) => doc.createdByAgentId === agentId)
          .map((doc) => ({
            id: doc.id,
            title: doc.title,
            createdAt: doc.createdAt,
          }))
      : allDocsMeta.map((doc) => ({
          id: doc.id,
          title: doc.title,
          createdAt: doc.createdAt,
        }));

    // Get apps
    const allApps = await appService.listApps();
    const apps = agentId
      ? allApps
          .filter((app) => app.createdByAgentId === agentId)
          .map((app) => ({
            id: app.id,
            title: app.title,
            createdAt: app.createdAt,
          }))
      : allApps.map((app) => ({
          id: app.id,
          title: app.title,
          createdAt: app.createdAt,
        }));

    // Get plans - we need to query all plans across all chats
    // This is a limitation: PlanService only has getPlansForChat
    // For now, return empty array (can be improved later)
    const plans: Array<{ planId: string; title: string; createdAt: string }> =
      [];

    return {
      documents,
      apps,
      plans,
    };
  }

  // ===== Helper Methods =====

  private async ensureChatExists(chatId: string): Promise<void> {
    const exists = this.db
      .prepare("SELECT 1 FROM chats WHERE id = ?")
      .get(chatId);
    if (!exists) {
      await this.createChat(chatId);
    }
  }

  getContextEfficiencyStats(): ContextEfficiencyStats {
    scheduleContextFootprintBackfill(this.db, {
      onBatchComplete: () => {
        this.contextEfficiencyCache = null;
      },
    });

    const now = Date.now();
    if (
      this.contextEfficiencyCache &&
      this.contextEfficiencyCache.expiresAt > now
    ) {
      return this.contextEfficiencyCache.stats;
    }

    if (this.contextEfficiencyComputing) {
      return (
        this.contextEfficiencyCache?.stats ?? EMPTY_CONTEXT_EFFICIENCY_STATS
      );
    }

    this.contextEfficiencyComputing = true;
    try {
      const stats = computeContextEfficiencyStats(this.db);
      const cacheTtlMs =
        stats.pendingFootprintTurns > 0 ? 10_000 : 300_000;
      this.contextEfficiencyCache = {
        expiresAt: Date.now() + cacheTtlMs,
        stats,
      };
      return stats;
    } catch (error) {
      console.error("[LocalStorage] Context efficiency compute failed:", error);
      return EMPTY_CONTEXT_EFFICIENCY_STATS;
    } finally {
      this.contextEfficiencyComputing = false;
    }
  }

  getToolUsageByAgent(): Record<
    string,
    { mostUsedTools: Array<{ tool: string; count: number }>; totalToolInvocations: number }
  > {
    const toolCountsByAgent = getToolCountsByAgent(this.db);
    const result: Record<
      string,
      {
        mostUsedTools: Array<{ tool: string; count: number }>;
        totalToolInvocations: number;
      }
    > = {};

    for (const [agentId, tools] of toolCountsByAgent.entries()) {
      result[agentId] = {
        mostUsedTools: tools.slice(0, 5),
        totalToolInvocations: sumToolInvocations(tools),
      };
    }
    return result;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
