#!/usr/bin/env node
/**
 * Merge chats + messages from one namespace chats.db into another.
 * Usage:
 *   node scripts/merge-chats-db.mjs --from onnNQFe3DN --to 85ZIB7mD1V
 *   node scripts/merge-chats-db.mjs --from-db /path/source.db --to-db /path/target.db --dry-run
 */

import { copyFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import os from "os";

const ORG = "Y8D4H7Yp3Z";
const USER_DATA_BASE = path.join(os.homedir(), ".paprwork-v2", "orgs", ORG, "namespaces");

function parseArgs() {
  const args = process.argv.slice(2);
  let fromNs = "";
  let toNs = "";
  let fromDb = "";
  let toDb = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from") fromNs = args[++i] ?? "";
    else if (arg === "--to") toNs = args[++i] ?? "";
    else if (arg === "--from-db") fromDb = args[++i] ?? "";
    else if (arg === "--to-db") toDb = args[++i] ?? "";
    else if (arg === "--dry-run") dryRun = true;
  }

  if (!fromDb && fromNs) {
    fromDb = path.join(USER_DATA_BASE, fromNs, "chats.db");
  }
  if (!toDb && toNs) {
    toDb = path.join(USER_DATA_BASE, toNs, "chats.db");
  }

  if (!fromDb || !toDb) {
    console.error(
      "Usage: merge-chats-db.mjs --from <namespaceId> --to <namespaceId> [--dry-run]",
    );
    process.exit(1);
  }

  return { fromDb: path.resolve(fromDb), toDb: path.resolve(toDb), dryRun };
}

function runSqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `sqlite3 failed on ${dbPath}`);
  }
  return (result.stdout ?? "").trim();
}

function countPair(dbPath) {
  const chats = runSqlite(dbPath, "SELECT COUNT(*) FROM chats;");
  const messages = runSqlite(dbPath, "SELECT COUNT(*) FROM messages;");
  return { chats: Number(chats), messages: Number(messages) };
}

async function backupDb(dbPath, label) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.backup-merge-${label}-${ts}`;
  await copyFile(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar)) {
      await copyFile(sidecar, backupPath + suffix);
    }
  }
  return backupPath;
}

async function main() {
  const { fromDb, toDb, dryRun } = parseArgs();

  if (!existsSync(fromDb)) {
    throw new Error(`Source not found: ${fromDb}`);
  }
  if (!existsSync(toDb)) {
    throw new Error(`Target not found: ${toDb}`);
  }

  const fromStat = await stat(fromDb);
  const toStat = await stat(toDb);

  console.log(`Merge chats.db${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  FROM: ${fromDb} (${(fromStat.size / 1e6).toFixed(1)} MB)`);
  console.log(`  TO:   ${toDb} (${(toStat.size / 1e6).toFixed(1)} MB)`);

  const beforeFrom = countPair(fromDb);
  const beforeTo = countPair(toDb);
  console.log(`\nBefore:`);
  console.log(`  source: ${beforeFrom.chats} chats, ${beforeFrom.messages} messages`);
  console.log(`  target: ${beforeTo.chats} chats, ${beforeTo.messages} messages`);

  if (dryRun) {
    const overlap = runSqlite(
      toDb,
      `ATTACH DATABASE '${fromDb.replace(/'/g, "''")}' AS src;
       SELECT COUNT(*) FROM src.chats c WHERE EXISTS (SELECT 1 FROM main.chats t WHERE t.id = c.id);
       DETACH DATABASE src;`,
    );
    console.log(`\nDry run: ${overlap} chat IDs already in target (will be skipped)`);
    console.log(
      `Would add ~${beforeFrom.chats - Number(overlap)} chats, ~${beforeFrom.messages} messages`,
    );
    return;
  }

  const backupPath = await backupDb(toDb, "pre-merge");
  console.log(`\nBacked up target -> ${path.basename(backupPath)}`);

  // Checkpoint target WAL so merge sees latest writes
  runSqlite(toDb, "PRAGMA wal_checkpoint(TRUNCATE);");

  const mergeSql = `
ATTACH DATABASE '${fromDb.replace(/'/g, "''")}' AS src;

INSERT OR IGNORE INTO main.chats (
  id, title, message_count, created_at, updated_at,
  summary_short, summary_medium, summary_long, summary_topics,
  summary_last_updated, summary_fetched_from_papr, summary_last_fetched_at,
  summary_enhanced, sync_status, last_synced_at, papr_chat_id,
  summary_base_message_count, memory_scope
)
SELECT
  id, title, message_count, created_at, updated_at,
  summary_short, summary_medium, summary_long, summary_topics,
  summary_last_updated, summary_fetched_from_papr, summary_last_fetched_at,
  summary_enhanced, sync_status, last_synced_at, papr_chat_id,
  summary_base_message_count, memory_scope
FROM src.chats;

INSERT OR IGNORE INTO main.messages (
  id, chat_id, role, content, timestamp,
  thinking, tool_calls, error, incomplete,
  model, prompt_tokens, completion_tokens, total_tokens, cost,
  sync_status, papr_message_id, last_sync_attempt, sync_error,
  source_agent_id, source_agent_name,
  cache_read_tokens, cache_write_tokens, sequence,
  hypothetical_prompt_tokens, context_naive_tokens,
  context_optimized_tokens, context_footprint_at
)
SELECT
  id, chat_id, role, content, timestamp,
  thinking, tool_calls, error, incomplete,
  model, prompt_tokens, completion_tokens, total_tokens, cost,
  sync_status, papr_message_id, last_sync_attempt, sync_error,
  source_agent_id, source_agent_name,
  cache_read_tokens, cache_write_tokens, sequence,
  hypothetical_prompt_tokens, context_naive_tokens,
  context_optimized_tokens, context_footprint_at
FROM src.messages;

UPDATE main.chats
SET message_count = (
  SELECT COUNT(*) FROM main.messages m WHERE m.chat_id = main.chats.id
);

INSERT OR IGNORE INTO main.context_stats
SELECT * FROM src.context_stats;

INSERT OR IGNORE INTO main.context_stats_billing_chats
SELECT * FROM src.context_stats_billing_chats;

DETACH DATABASE src;
`;

  console.log("\nMerging (this may take a minute for large databases)...");
  runSqlite(toDb, mergeSql);

  const afterTo = countPair(toDb);
  const addedChats = afterTo.chats - beforeTo.chats;
  const addedMessages = afterTo.messages - beforeTo.messages;

  console.log(`\nAfter:`);
  console.log(`  target: ${afterTo.chats} chats, ${afterTo.messages} messages`);
  console.log(`  added:  ${addedChats} chats, ${addedMessages} messages`);
  console.log("\nDone. Restart Paprwork (Cmd+Q) so the chat list reloads.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
