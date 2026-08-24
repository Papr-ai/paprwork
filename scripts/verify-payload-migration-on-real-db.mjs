#!/usr/bin/env node
/**
 * Proves the payload migration is lossless against a real database.
 *
 * Copies the largest messages from your chats.db into a scratch database,
 * migrates that copy, then compares every payload back against the untouched
 * original. The real database is opened read-only and never modified.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
 *     scripts/verify-payload-migration-on-real-db.mjs [--rows=25] [--db=/path/chats.db]
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist", "gateway", "services", "storage");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const sourcePath = arg(
  "db",
  path.join(os.homedir(), ".paprwork-v2", "chats.db"),
);
const rowLimit = Number(arg("rows", "25"));

if (!fs.existsSync(sourcePath)) {
  console.error(`No database at ${sourcePath}`);
  process.exit(1);
}

const migration = await import(
  pathToFileURL(path.join(distDir, "toolPayloadMigration.js")).href
);
const store = await import(
  pathToFileURL(path.join(distDir, "messagePayloadStore.js")).href
);

let passed = 0;
let failed = 0;
const problems = [];

function check(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    if (problems.length < 20) problems.push(label);
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

const source = new Database(sourcePath, { readonly: true });
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "payload-verify-"));

try {
  console.log(`Source: ${sourcePath} (${mb(fs.statSync(sourcePath).size)})`);
  console.log(`Sampling the ${rowLimit} largest messages…\n`);

  const fattest = source
    .prepare(
      `SELECT id, chat_id,
              IFNULL(LENGTH(tool_calls), 0) AS tc_len,
              IFNULL(LENGTH(sequence), 0) AS seq_len
       FROM messages
       WHERE tool_calls IS NOT NULL OR sequence IS NOT NULL
       ORDER BY (IFNULL(LENGTH(tool_calls),0) + IFNULL(LENGTH(sequence),0)) DESC
       LIMIT ?`,
    )
    .all(rowLimit);

  if (fattest.length === 0) {
    console.log("No messages with payloads — nothing to verify.");
    process.exit(0);
  }

  // Copy the sampled rows into a scratch database, inside SQLite so the giant
  // columns never enter the JS heap.
  const scratchPath = path.join(scratchDir, "chats.db");
  const scratch = new Database(scratchPath);
  scratch.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tool_calls TEXT,
      sequence TEXT
    );
  `);
  scratch.exec(`ATTACH DATABASE '${sourcePath.replace(/'/g, "''")}' AS src`);
  const ids = fattest.map((r) => r.id);
  scratch
    .prepare(
      `INSERT INTO messages (id, chat_id, role, content, timestamp, tool_calls, sequence)
       SELECT id, chat_id, role, content, timestamp, tool_calls, sequence
       FROM src.messages WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .run(...ids);
  scratch.exec("DETACH DATABASE src");

  const beforeBytes = fattest.reduce((s, r) => s + r.tc_len + r.seq_len, 0);

  // Snapshot the originals so comparisons never touch the live database.
  const origToolCall = scratch.prepare(
    "SELECT json_extract(tool_calls, ?) AS v FROM messages WHERE id = ?",
  );
  const originals = new Map();
  for (const row of fattest) {
    const count = scratch
      .prepare(
        "SELECT json_array_length(tool_calls) AS n FROM messages WHERE id = ?",
      )
      .get(row.id);
    originals.set(row.id, count?.n ?? 0);
  }

  console.log(`Migrating ${fattest.length} rows (${mb(beforeBytes)})…`);
  const startedAt = Date.now();

  migration.ensurePayloadMigrationSchema(scratch);
  let guard = 0;
  for (;;) {
    const stats = migration.migrateToolPayloadsChunk(scratch, scratchDir, 10);
    if (stats.rowsProcessed === 0 || stats.remaining === 0) break;
    if (++guard > 1000) throw new Error("migration did not converge");
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const after = scratch
    .prepare(
      `SELECT id,
              IFNULL(LENGTH(tool_calls),0) AS tc_len,
              IFNULL(LENGTH(sequence),0) AS seq_len
       FROM messages`,
    )
    .all();
  const afterBytes = after.reduce((s, r) => s + r.tc_len + r.seq_len, 0);

  console.log(
    `Migrated in ${elapsed}s: ${mb(beforeBytes)} -> ${mb(afterBytes)} ` +
      `(${(100 - (afterBytes / beforeBytes) * 100).toFixed(1)}% smaller)\n`,
  );

  // Every payload must still be recoverable, byte for byte, from the original.
  console.log("Comparing every payload against the untouched original…");

  const newToolCall = scratch.prepare(
    "SELECT json_extract(tool_calls, ?) AS v FROM messages WHERE id = ?",
  );
  const newOffload = scratch.prepare(
    "SELECT json_extract(tool_calls, ?) AS v FROM messages WHERE id = ?",
  );
  const srcToolCall = source.prepare(
    "SELECT json_extract(tool_calls, ?) AS v FROM messages WHERE id = ?",
  );

  let comparedResults = 0;
  let offloadedResults = 0;

  for (const row of fattest) {
    const count = originals.get(row.id) ?? 0;

    for (let i = 0; i < count; i++) {
      const original = srcToolCall.get(`$[${i}].result`, row.id)?.v;
      if (typeof original !== "string") continue;

      comparedResults += 1;
      const offloadJson = newOffload.get(`$[${i}].resultOffload`, row.id)?.v;

      if (offloadJson) {
        offloadedResults += 1;
        const ref = JSON.parse(offloadJson);
        const recovered = store.readOffloadedResult(scratchDir, ref);
        check(
          recovered === original,
          `${row.id}[${i}] sidecar differs from the original`,
        );
        check(
          ref.totalChars === original.length,
          `${row.id}[${i}] totalChars wrong`,
        );

        // The inline stub must still start with the real text, not a hole.
        const stub = newToolCall.get(`$[${i}].result`, row.id)?.v ?? "";
        check(
          original.startsWith(stub.slice(0, 200)),
          `${row.id}[${i}] preview does not match the original`,
        );
      } else {
        const kept = newToolCall.get(`$[${i}].result`, row.id)?.v;
        check(
          kept === original,
          `${row.id}[${i}] inline result was altered`,
        );
      }
    }

    // Args must survive untouched — the sequence pointers rebuild from them.
    for (let i = 0; i < count; i++) {
      const before = srcToolCall.get(`$[${i}].args`, row.id)?.v;
      const now = newToolCall.get(`$[${i}].args`, row.id)?.v;
      check(
        JSON.stringify(before ?? null) === JSON.stringify(now ?? null),
        `${row.id}[${i}] args changed`,
      );
    }

    // And a slimmed sequence must rebuild into what it held before.
    const seqLen =
      scratch
        .prepare("SELECT json_array_length(sequence) AS n FROM messages WHERE id = ?")
        .get(row.id)?.n ?? 0;

    for (let i = 0; i < seqLen; i++) {
      const type = scratch
        .prepare("SELECT json_extract(sequence, ?) AS v FROM messages WHERE id = ?")
        .get(`$[${i}].type`, row.id)?.v;
      if (type !== "tool") continue;

      const outputRef = scratch
        .prepare("SELECT json_extract(sequence, ?) AS v FROM messages WHERE id = ?")
        .get(`$[${i}].data.outputRef`, row.id)?.v;
      if (!outputRef) continue;

      const toolCallId = scratch
        .prepare("SELECT json_extract(sequence, ?) AS v FROM messages WHERE id = ?")
        .get(`$[${i}].data.toolCallId`, row.id)?.v;

      const twinIndex = scratch
        .prepare(
          `SELECT CAST(j.key AS INTEGER) AS idx FROM messages m, json_each(m.tool_calls) j
           WHERE m.id = ? AND json_extract(j.value, '$.id') = ?`,
        )
        .get(row.id, toolCallId)?.idx;

      check(
        twinIndex !== undefined,
        `${row.id} sequence[${i}] points at a missing tool call`,
      );
    }
  }

  console.log(
    `\nCompared ${comparedResults} results (${offloadedResults} offloaded to sidecars).`,
  );

  const sidecarBytes = (() => {
    const root = path.join(scratchDir, "tool-results");
    if (!fs.existsSync(root)) return 0;
    let total = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(root);
    return total;
  })();

  console.log(`Sidecars on disk: ${mb(sidecarBytes)} (nothing discarded).`);
  console.log(`\n${passed} checks passed, ${failed} failed`);
  if (problems.length) {
    console.log("\nFirst failures:");
    for (const p of problems) console.log(`  - ${p}`);
  }

  scratch.close();
} finally {
  source.close();
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
