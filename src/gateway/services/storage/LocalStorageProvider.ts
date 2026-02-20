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
} from "./IStorageProvider";
import { ChatExporter } from "./ChatExporter.js";

export class LocalStorageProvider implements IStorageProvider {
  private db!: Database.Database;
  private dbPath: string;
  private exporter: ChatExporter;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, "chats.db");
    this.exporter = new ChatExporter();
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    await fs.ensureDir(path.dirname(this.dbPath));

    // Initialize SQLite database
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");

    // Create schema
    this.createSchema();

    // Initialize PAPR folder structure
    await this.exporter.initialize();
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

    // Add sequence column if missing (V1-style interleaved text/tool sequence)
    if (!columnNames.includes("sequence")) {
      console.log(
        '[LocalStorage] Adding "sequence" column to messages table...',
      );
      this.db.exec("ALTER TABLE messages ADD COLUMN sequence TEXT"); // Store as JSON
    }

    console.log("[LocalStorage] Database migration complete");

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_sync_status ON messages(chat_id, sync_status);
      CREATE INDEX IF NOT EXISTS idx_messages_unsynced ON messages(chat_id, sync_status) 
        WHERE sync_status IN ('sync_pending', 'sync_failed');
    `);
  }

  // ===== Message Operations =====

  async saveMessage(chatId: string, message: StoredMessage): Promise<void> {
    // Ensure chat exists
    await this.ensureChatExists(chatId);

    console.log(`[LocalStorage] Saving message to chat ${chatId}:`, {
      id: message.id,
      role: message.role,
      hasThinking: !!message.thinking,
      hasToolCalls: !!message.toolCalls,
      hasError: !!message.error,
      incomplete: message.incomplete,
    });

    // Insert message
    this.db
      .prepare(`
      INSERT INTO messages (
        id, chat_id, role, content, timestamp,
        thinking, tool_calls, error, incomplete,
        model, prompt_tokens, completion_tokens, total_tokens,
        sync_status, papr_message_id,
        source_agent_id, source_agent_name,
        sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        message.id || uuidv4(),
        chatId,
        message.role,
        message.content,
        message.timestamp || new Date().toISOString(),
        message.thinking || null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.error || null,
        message.incomplete ? 1 : 0,
        message.model || null,
        message.prompt_tokens || 0,
        message.completion_tokens || 0,
        message.total_tokens || 0,
        message.sync_status || "local",
        message.papr_message_id || null,
        message.source_agent_id || "main-agent",
        message.source_agent_name || "Paprwork Assistant",
        message.sequence ? JSON.stringify(message.sequence) : null, // Store sequence as JSON
      );

    // Update chat message count and updated_at
    this.db
      .prepare(`
      UPDATE chats 
      SET message_count = message_count + 1,
          updated_at = ?
      WHERE id = ?
    `)
      .run(new Date().toISOString(), chatId);
  }

  async loadMessages(
    chatId: string,
    limit?: number,
    skip?: number,
  ): Promise<StoredMessage[]> {
    let query = `
      SELECT 
        id, chat_id, role, content, timestamp,
        thinking, tool_calls, error, incomplete,
        model, prompt_tokens, completion_tokens, total_tokens,
        sync_status, papr_message_id, last_sync_attempt, sync_error,
        source_agent_id, source_agent_name,
        sequence
      FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp ASC
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    if (skip) {
      query += ` OFFSET ${skip}`;
    }

    const rows = this.db.prepare(query).all(chatId) as any[];

    console.log(
      `[LocalStorage] Loaded ${rows.length} messages for chat ${chatId}`,
    );
    rows.forEach((row, i) => {
      console.log(
        `  Message ${i}: role=${row.role}, hasThinking=${!!row.thinking}, hasToolCalls=${!!row.tool_calls}`,
      );
    });

    return rows.map((row) => ({
      id: row.id,
      chat_id: row.chat_id,
      role: row.role as "user" | "assistant",
      content: row.content,
      timestamp: row.timestamp,
      thinking: row.thinking || undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      sequence: row.sequence ? JSON.parse(row.sequence) : undefined, // Parse sequence from JSON
      error: row.error || undefined,
      incomplete: row.incomplete === 1,
      model: row.model,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
      sync_status: row.sync_status as any,
      papr_message_id: row.papr_message_id,
      last_sync_attempt: row.last_sync_attempt,
      sync_error: row.sync_error,
      source_agent_id: row.source_agent_id || "main-agent",
      source_agent_name: row.source_agent_name || "Paprwork Assistant",
    }));
  }

  async loadMessagesForLLM(chatId: string): Promise<any[]> {
    // Get chat metadata
    const chat = this.db
      .prepare(`
      SELECT id, title, message_count, 
             summary_short, summary_medium, summary_long, summary_topics
      FROM chats 
      WHERE id = ?
    `)
      .get(chatId) as any;

    if (!chat) {
      return [];
    }

    // If no summary, return all messages with toolCalls intact
    // IMPORTANT: Pass toolCalls as a separate field so historyFormatter
    // can produce proper AI SDK structured messages (not [tool_activity] text)
    if (!chat.summary_long) {
      const messages = await this.loadMessages(chatId);
      return messages.map((message) => ({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
      }));
    }

    // Get recent messages AFTER summary
    // When we have a summary, we only need the most recent messages (10-15)
    // because the summary covers all earlier context
    // Without summary, load more messages (50) for full context
    const recentMessageLimit = chat.summary_long ? 15 : 50;
    
    const recentMessages = this.db
      .prepare(`
      SELECT role, content, thinking, tool_calls
      FROM messages 
      WHERE chat_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `)
      .all(chatId, recentMessageLimit) as any[];

    // Reverse to chronological order
    recentMessages.reverse();

    const archivedCount = chat.message_count - recentMessages.length;
    const topics = chat.summary_topics ? JSON.parse(chat.summary_topics) : [];

    console.log(`[LocalStorage] Loading LLM context for chat ${chatId}:`);
    console.log(`  Total messages: ${chat.message_count}`);
    console.log(`  Archived (in summary): ${archivedCount}`);
    console.log(`  Recent (loaded): ${recentMessages.length}`);
    console.log(`  Summary exists: ${!!chat.summary_long}`);

    // Export chat to file and get path
    const messages = await this.loadMessages(chatId);
    const chatFilePath = await this.exporter.exportChat(
      chatId,
      chat.title,
      messages,
    );

    // Build summary for injection as user message
    const summaryForSystemPrompt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 ARCHIVED CONVERSATION SUMMARY (${archivedCount} older messages archived)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This conversation has been ongoing for ${chat.message_count} messages total.
The summary below covers the first ${archivedCount} messages.
Only the most recent ${recentMessages.length} messages are loaded in context after this summary.

Full conversation export: ${chatFilePath}
You can use bash/grep/read tools to search the full history if needed.

───────────────────────────────────────────────────────────

FULL SESSION SUMMARY:
${chat.summary_long}

RECENT CONTEXT (last ~100 messages):
${chat.summary_medium}

CURRENT BATCH (last 15 messages):
${chat.summary_short}

KEY TOPICS: ${topics.join(", ")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // Format recent messages — pass toolCalls through for structured AI SDK format
    const formattedRecent = recentMessages.map((message) => {
      const parsedToolCalls =
        typeof message.tool_calls === "string" && message.tool_calls.length > 0
          ? (JSON.parse(message.tool_calls) as unknown[])
          : undefined;

      return {
        role: typeof message.role === "string" ? message.role : "assistant",
        content: typeof message.content === "string" ? message.content : "",
        toolCalls: parsedToolCalls,
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
             summary_fetched_from_papr, summary_last_fetched_at
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
      fetched_from_papr: chat.summary_fetched_from_papr === 1,
      last_fetched_at: chat.summary_last_fetched_at,
    };
  }

  async saveSummary(chatId: string, summary: StoredSummary): Promise<void> {
    this.db
      .prepare(`
      UPDATE chats 
      SET summary_short = ?,
          summary_medium = ?,
          summary_long = ?,
          summary_topics = ?,
          summary_last_updated = ?,
          summary_fetched_from_papr = ?,
          summary_last_fetched_at = ?
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
        chatId,
      );
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
    updates: Partial<{ title: string }>,
  ): Promise<void> {
    if (updates.title !== undefined) {
      this.db
        .prepare(`
        UPDATE chats 
        SET title = ?,
            updated_at = ?
        WHERE id = ?
      `)
        .run(updates.title, new Date().toISOString(), chatId);
    }
  }

  async deleteChat(chatId: string): Promise<void> {
    // Foreign key cascade will delete messages
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  }

  async listChats(): Promise<ChatMetadata[]> {
    const rows = this.db
      .prepare(`
      SELECT id, title, message_count, created_at as createdAt, updated_at as updatedAt, last_synced_at
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
    }));
  }

  async getChat(chatId: string): Promise<ChatMetadata | null> {
    const row = this.db
      .prepare(`
      SELECT id, title, message_count, created_at as createdAt, updated_at as updatedAt, last_synced_at
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

  async getUnsyncedMessages(chatId: string): Promise<StoredMessage[]> {
    const rows = this.db
      .prepare(`
      SELECT * FROM messages 
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
    has_summary: boolean;
  }> {
    const chat = this.db
      .prepare(`
      SELECT message_count, summary_long FROM chats WHERE id = ?
    `)
      .get(chatId) as any;

    if (!chat) {
      return { message_count: 0, token_count: 0, has_summary: false };
    }

    // Calculate token count (rough estimate)
    const messages = await this.loadMessages(chatId);
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const token_count = Math.ceil(totalChars / 4); // 1 token ≈ 4 chars

    return {
      message_count: chat.message_count,
      token_count,
      has_summary: !!chat.summary_long,
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

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
