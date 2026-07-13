import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateFootprintColumns } from "../src/gateway/services/storage/contextFootprintStore.js";
import {
  applyFootprintStoredInCache,
  readContextStatsCache,
  rebuildContextStatsCacheNow,
  recordMessageTokensInCache,
} from "../src/gateway/services/storage/contextStatsCache.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      message_count INTEGER DEFAULT 0,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary_short TEXT,
      summary_medium TEXT,
      summary_long TEXT,
      summary_topics TEXT,
      summary_enhanced TEXT,
      summary_last_updated TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      hypothetical_prompt_tokens INTEGER,
      context_naive_tokens INTEGER,
      context_optimized_tokens INTEGER,
      context_footprint_at TEXT
    );
  `);
  migrateFootprintColumns(db);
  return db;
}

describe("contextStatsCache", () => {
  it("increments pending on assistant save then moves to computed on footprint", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chats (id, message_count, created_at, updated_at)
       VALUES ('c1', 1, '2026-01-01', '2026-01-01')`,
    ).run();

    recordMessageTokensInCache(db, "c1", "assistant", 100, 20, 120);
    let stats = readContextStatsCache(db);
    expect(stats.pendingTurns).toBe(1);
    expect(stats.pendingPromptTokens).toBe(100);
    expect(stats.computedTurns).toBe(0);
    expect(stats.chatsWithBilling).toBe(1);

    applyFootprintStoredInCache(db, 100, 250);
    stats = readContextStatsCache(db);
    expect(stats.pendingTurns).toBe(0);
    expect(stats.computedTurns).toBe(1);
    expect(stats.projectedPromptTokens).toBe(250);
    expect(stats.computedPromptTokens).toBe(100);
  });

  it("rebuild from messages matches stored footprints", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chats (id, message_count, created_at, updated_at)
       VALUES ('c1', 2, '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO messages
       (id, chat_id, role, content, timestamp, prompt_tokens, completion_tokens, total_tokens, hypothetical_prompt_tokens)
       VALUES ('m1', 'c1', 'assistant', 'hi', '2026-01-01', 50, 10, 60, 120),
              ('m2', 'c1', 'assistant', 'bye', '2026-01-02', 80, 15, 95, NULL)`,
    ).run();

    rebuildContextStatsCacheNow(db);
    const stats = readContextStatsCache(db);
    expect(stats.measuredPromptTokens).toBe(130);
    expect(stats.computedTurns).toBe(1);
    expect(stats.pendingTurns).toBe(1);
    expect(stats.projectedPromptTokens).toBe(120);
    expect(stats.pendingPromptTokens).toBe(80);
    expect(stats.needsRebuild).toBe(false);
  });

  it("reads cache row without scanning messages", () => {
    const db = createTestDb();
    db.prepare(
      `UPDATE context_stats
       SET measured_prompt_tokens = 999,
           pending_turns = 0,
           needs_rebuild = 0
       WHERE id = 1`,
    ).run();

    const stats = readContextStatsCache(db);
    expect(stats.measuredPromptTokens).toBe(999);
    expect(stats.needsRebuild).toBe(false);
  });
});
