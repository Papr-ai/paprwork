/**
 * Backfill for rows written before tool payloads were offloaded.
 *
 * Existing databases carry two copies of every tool payload (`tool_calls` and
 * `sequence`) and inline results that can reach 100MB+. Rewriting them makes
 * the database much smaller and, more importantly, removes the rows that could
 * exhaust the heap when a chat is opened.
 *
 * Every rewrite happens inside SQLite via json_set/json_remove, so a giant
 * column is never parsed in JS. The only value that crosses into JS is one
 * result at a time, which we stream straight to its sidecar file.
 *
 * The work is idempotent and resumable: each message is flagged once handled,
 * so an interrupted run just picks up where it stopped.
 */

import type Database from "better-sqlite3";
import {
  offloadRowResults,
  offloadRowSequenceOutputs,
  slimRowSequence,
  type MessageRow,
} from "./toolPayloadRowRewrite.js";

/** Rows per chunk; the loop yields between chunks so the gateway stays responsive. */
const CHUNK_SIZE = 50;

export interface PayloadMigrationStats {
  rowsProcessed: number;
  resultsOffloaded: number;
  charsOffloaded: number;
  remaining: number;
}

/** Adds the progress flag plus a partial index so resuming stays cheap. */
export function ensurePayloadMigrationSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{
    name: string;
  }>;

  if (!columns.some((c) => c.name === "tool_payload_migrated")) {
    db.exec(
      "ALTER TABLE messages ADD COLUMN tool_payload_migrated INTEGER DEFAULT 0",
    );
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_payload_pending
     ON messages(id) WHERE tool_payload_migrated = 0`,
  );
}

/** How many messages still need rewriting. */
export function countPendingPayloadMigrations(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE tool_payload_migrated = 0
         AND (tool_calls IS NOT NULL OR sequence IS NOT NULL)`,
    )
    .get() as { n: number };
  return row.n;
}

/** Rewrite one chunk of messages. Safe to call repeatedly. */
export function migrateToolPayloadsChunk(
  db: Database.Database,
  dbDir: string,
  limit: number = CHUNK_SIZE,
): PayloadMigrationStats {
  const rows = db
    .prepare(
      `SELECT id, chat_id FROM messages
       WHERE tool_payload_migrated = 0
         AND (tool_calls IS NOT NULL OR sequence IS NOT NULL)
       LIMIT ?`,
    )
    .all(limit) as MessageRow[];

  const markDone = db.prepare(
    "UPDATE messages SET tool_payload_migrated = 1 WHERE id = ?",
  );

  let resultsOffloaded = 0;
  let charsOffloaded = 0;

  for (const row of rows) {
    try {
      const offload = offloadRowResults(db, dbDir, row);
      resultsOffloaded += offload.offloaded;
      charsOffloaded += offload.chars;

      // Slim first: whatever still carries an output afterwards has no twin in
      // `tool_calls`, so it needs a sidecar of its own.
      slimRowSequence(db, row);
      const orphans = offloadRowSequenceOutputs(db, dbDir, row);
      resultsOffloaded += orphans.offloaded;
      charsOffloaded += orphans.chars;
    } catch (error) {
      console.error(
        `[PayloadMigration] Skipping message ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
    // Flag either way so one bad row cannot stall the backfill.
    markDone.run(row.id);
  }

  // Messages with neither column never need work.
  db.prepare(
    `UPDATE messages SET tool_payload_migrated = 1
     WHERE tool_payload_migrated = 0
       AND tool_calls IS NULL AND sequence IS NULL`,
  ).run();

  return {
    rowsProcessed: rows.length,
    resultsOffloaded,
    charsOffloaded,
    remaining: countPendingPayloadMigrations(db),
  };
}

/**
 * Run the backfill in the background, yielding between chunks.
 *
 * Startup is not blocked: the first chunk runs after the event loop drains, and
 * each chunk hands control back so chat traffic is not held up.
 */
export function startToolPayloadMigration(
  db: Database.Database,
  dbDir: string,
): void {
  let pending: number;
  try {
    ensurePayloadMigrationSchema(db);
    pending = countPendingPayloadMigrations(db);
  } catch (error) {
    console.error(
      "[PayloadMigration] Could not prepare backfill:",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  if (pending === 0) return;

  console.log(
    `[PayloadMigration] Compacting stored tool payloads for ${pending.toLocaleString()} messages in the background`,
  );

  const startedAt = Date.now();
  let totalResults = 0;
  let totalChars = 0;
  let lastLoggedAt = 0;

  const step = (): void => {
    let stats: PayloadMigrationStats;
    try {
      stats = migrateToolPayloadsChunk(db, dbDir);
    } catch (error) {
      console.error(
        "[PayloadMigration] Backfill stopped:",
        error instanceof Error ? error.message : error,
      );
      return;
    }

    totalResults += stats.resultsOffloaded;
    totalChars += stats.charsOffloaded;

    if (stats.rowsProcessed === 0 || stats.remaining === 0) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[PayloadMigration] Done in ${seconds}s — moved ${totalResults.toLocaleString()} results ` +
          `(${(totalChars / 1024 / 1024).toFixed(0)}MB) out of the database. ` +
          "Run VACUUM to release the freed space.",
      );
      return;
    }

    if (Date.now() - lastLoggedAt > 15_000) {
      lastLoggedAt = Date.now();
      console.log(
        `[PayloadMigration] ${stats.remaining.toLocaleString()} messages left ` +
          `(${(totalChars / 1024 / 1024).toFixed(0)}MB moved so far)`,
      );
    }

    setTimeout(step, 25);
  };

  setTimeout(step, 5_000);
}
