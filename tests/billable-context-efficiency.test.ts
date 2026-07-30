import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateFootprintColumns } from "../src/gateway/services/storage/contextFootprintStore.js";
import {
  applyFootprintStoredInCache,
  rebuildContextStatsCacheNow,
  recordMessageTokensInCache,
} from "../src/gateway/services/storage/contextStatsCache.js";
import { computeContextEfficiencyStats } from "../src/gateway/services/storage/contextEfficiencyStats.js";

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
      summary_last_updated TEXT,
      summary_base_message_count INTEGER
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_calls TEXT,
      timestamp TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      model TEXT,
      cost REAL,
      hypothetical_prompt_tokens INTEGER,
      context_naive_tokens INTEGER,
      context_optimized_tokens INTEGER,
      context_footprint_at TEXT
    );
  `);
  migrateFootprintColumns(db);
  return db;
}

describe("billable context efficiency", () => {
  it("uses prompt + completion for actual usage, not inflated total_tokens", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chats (id, message_count, created_at, updated_at)
       VALUES ('c1', 1, '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO messages
       (id, chat_id, role, content, timestamp, prompt_tokens, completion_tokens, total_tokens, hypothetical_prompt_tokens)
       VALUES ('m1', 'c1', 'assistant', 'hi', '2026-07-30T12:00:00.000Z', 100, 50, 999999, 250)`,
    ).run();

    rebuildContextStatsCacheNow(db);
    const stats = computeContextEfficiencyStats(db);

    expect(stats.totalTokensConsumed).toBe(150);
    expect(stats.hypotheticalTokensWithoutOptimizations).toBeGreaterThan(150);
    expect(stats.lifetimeTokensSaved).toBeGreaterThan(0);
    expect(stats.periods.thisMonth.actualTokens).toBe(150);
  });

  it("records billable totals incrementally in context_stats cache", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO chats (id, message_count, created_at, updated_at)
       VALUES ('c1', 1, '2026-01-01', '2026-01-01')`,
    ).run();

    recordMessageTokensInCache(db, "c1", "assistant", 40, 10, 500000);
    applyFootprintStoredInCache(db, 40, 120);

    const row = db
      .prepare(`SELECT total_tokens_consumed FROM context_stats WHERE id = 1`)
      .get() as { total_tokens_consumed: number };

    expect(row.total_tokens_consumed).toBe(50);
  });
});
