#!/usr/bin/env node
/**
 * Backfill tests for the tool payload migration.
 *
 * Builds a database shaped like one written before offloading existed — two
 * copies of every payload and results large enough to blow the heap — then
 * checks the migration shrinks it without losing anything.
 *
 * Runs under Electron because better-sqlite3 is built for Electron's runtime.
 *
 * Usage:
 *   npm run test:payload-migration
 *   # or: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-tool-payload-migration.mjs
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist", "gateway", "services", "storage");

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed += 1;
}

function fail(label, detail) {
  console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
}

function check(label, condition, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function importDist(file) {
  const target = path.join(distDir, file);
  if (!fs.existsSync(target)) {
    console.error(
      `Missing ${target}\nBuild the gateway first: npm run build:gateway`,
    );
    process.exit(1);
  }
  return import(pathToFileURL(target).href);
}

const migration = await importDist("toolPayloadMigration.js");
const store = await importDist("messagePayloadStore.js");

const { OFFLOAD_THRESHOLD_CHARS, MAX_INLINE_PAYLOAD_BYTES } = store;

/** A message as it was written before offloading: payload stored twice. */
function legacyRow({ id, chatId, results }) {
  const toolCalls = results.map((result, i) => ({
    id: `${id}-tc-${i}`,
    name: "bash",
    args: { command: `run ${i}` },
    result,
    status: "success",
  }));

  const sequence = [
    { type: "text", data: "Working on it." },
    ...results.map((result, i) => ({
      type: "tool",
      data: {
        toolCallId: `${id}-tc-${i}`,
        name: "bash",
        input: { command: `run ${i}` },
        output: result,
        status: "success",
      },
    })),
  ];

  return {
    id,
    chat_id: chatId,
    role: "assistant",
    content: "done",
    timestamp: new Date().toISOString(),
    tool_calls: JSON.stringify(toolCalls),
    sequence: JSON.stringify(sequence),
  };
}

function createDb(dbDir) {
  const db = new Database(path.join(dbDir, "chats.db"));
  db.exec(`
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
  return db;
}

function insert(db, row) {
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, timestamp, tool_calls, sequence)
     VALUES (@id, @chat_id, @role, @content, @timestamp, @tool_calls, @sequence)`,
  ).run(row);
}

function readRow(db, id) {
  const row = db
    .prepare("SELECT tool_calls, sequence FROM messages WHERE id = ?")
    .get(id);
  return {
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    sequence: row.sequence ? JSON.parse(row.sequence) : undefined,
    rawBytes: (row.tool_calls?.length ?? 0) + (row.sequence?.length ?? 0),
  };
}

/** Drains the chunked migration the way the background loop would. */
function runMigration(db, dbDir) {
  migration.ensurePayloadMigrationSchema(db);
  let guard = 0;
  for (;;) {
    const stats = migration.migrateToolPayloadsChunk(db, dbDir);
    if (stats.rowsProcessed === 0 || stats.remaining === 0) return stats;
    if (++guard > 1000) throw new Error("migration did not converge");
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "payload-migration-"));

try {
  section("Legacy rows shrink without losing data");
  {
    const dbDir = path.join(tmp, "case-1");
    fs.mkdirSync(dbDir);
    const db = createDb(dbDir);

    const huge = "H".repeat(OFFLOAD_THRESHOLD_CHARS + 5_000);
    const small = "small result";
    insert(db, legacyRow({ id: "m1", chatId: "c1", results: [huge, small] }));

    const before = readRow(db, "m1");
    runMigration(db, dbDir);
    const after = readRow(db, "m1");

    check(
      "row is dramatically smaller",
      after.rawBytes < before.rawBytes / 2,
      `${before.rawBytes} -> ${after.rawBytes}`,
    );
    check(
      "row is now under the read limit",
      after.rawBytes < MAX_INLINE_PAYLOAD_BYTES,
      `${after.rawBytes} bytes`,
    );

    const offloaded = after.toolCalls[0];
    check("oversized result has a pointer", Boolean(offloaded.resultOffload));
    check(
      "sidecar holds the original text",
      store.readOffloadedResult(dbDir, offloaded.resultOffload) === huge,
    );
    check(
      "preview stayed inline",
      offloaded.result.startsWith(huge.slice(0, 100)) &&
        offloaded.result.includes("get_full_tool_result"),
    );
    check(
      "small result untouched",
      after.toolCalls[1].result === small && !after.toolCalls[1].resultOffload,
    );

    // The duplicate copies are gone from `sequence`, but a read rebuilds them.
    check(
      "sequence no longer duplicates the payload",
      !JSON.stringify(after.sequence).includes(small.repeat(2)) &&
        after.sequence[2].data.output === undefined,
    );

    const restored = store.restoreSequencePayloads(after.sequence, after.toolCalls);
    check("text items survive", restored[0].data === "Working on it.");
    check(
      "small output rebuilt exactly",
      restored[2].data.output === small,
      JSON.stringify(restored[2].data.output)?.slice(0, 80),
    );
    check(
      "inputs rebuilt exactly",
      JSON.stringify(restored[1].data.input) === JSON.stringify({ command: "run 0" }),
    );
    check(
      "offloaded output shows the preview, not a hole",
      typeof restored[1].data.output === "string" &&
        restored[1].data.output.includes("get_full_tool_result"),
    );
    check(
      "status metadata preserved",
      restored[1].data.status === "success" &&
        after.toolCalls[0].status === "success",
    );

    db.close();
  }

  section("Many medium results still fit the row budget");
  {
    const dbDir = path.join(tmp, "case-2");
    fs.mkdirSync(dbDir);
    const db = createDb(dbDir);

    const medium = "M".repeat(200 * 1024);
    insert(
      db,
      legacyRow({ id: "m1", chatId: "c1", results: Array(12).fill(medium) }),
    );

    runMigration(db, dbDir);
    const after = readRow(db, "m1");

    check(
      "row fits under the read limit",
      after.rawBytes < MAX_INLINE_PAYLOAD_BYTES,
      `${after.rawBytes} bytes`,
    );
    const spilled = after.toolCalls.filter((tc) => tc.resultOffload);
    check("largest results spilled to sidecars", spilled.length > 0);
    check(
      "every spilled result is readable in full",
      spilled.every((tc) => store.readOffloadedResult(dbDir, tc.resultOffload) === medium),
    );

    db.close();
  }

  section("Orphan sequence output gets its own sidecar");
  {
    const dbDir = path.join(tmp, "case-3");
    fs.mkdirSync(dbDir);
    const db = createDb(dbDir);

    const huge = "O".repeat(OFFLOAD_THRESHOLD_CHARS + 2_000);
    insert(db, {
      id: "m1",
      chat_id: "c1",
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      tool_calls: null,
      sequence: JSON.stringify([
        { type: "tool", data: { toolCallId: "orphan", name: "x", output: huge } },
      ]),
    });

    runMigration(db, dbDir);
    const after = readRow(db, "m1");

    check(
      "orphan row shrank",
      after.rawBytes < MAX_INLINE_PAYLOAD_BYTES,
      `${after.rawBytes} bytes`,
    );
    check(
      "orphan payload is readable in full",
      store.readOffloadedResult(dbDir, after.sequence[0].data.outputOffload) === huge,
    );

    db.close();
  }

  section("Edge cases and reruns");
  {
    const dbDir = path.join(tmp, "case-4");
    fs.mkdirSync(dbDir);
    const db = createDb(dbDir);

    const huge = "R".repeat(OFFLOAD_THRESHOLD_CHARS + 1_000);
    insert(db, legacyRow({ id: "m1", chatId: "c1", results: [huge] }));

    // Rows the migration must tolerate rather than choke on.
    insert(db, {
      id: "m2",
      chat_id: "c1",
      role: "user",
      content: "hi",
      timestamp: new Date().toISOString(),
      tool_calls: null,
      sequence: null,
    });
    insert(db, {
      id: "m3",
      chat_id: "c1",
      role: "assistant",
      content: "broken",
      timestamp: new Date().toISOString(),
      tool_calls: "{not json",
      sequence: null,
    });
    insert(db, {
      id: "m4",
      chat_id: "c1",
      role: "assistant",
      content: "null output",
      timestamp: new Date().toISOString(),
      tool_calls: JSON.stringify([{ id: "tc", name: "noop", args: {} }]),
      sequence: JSON.stringify([
        { type: "tool", data: { toolCallId: "tc", name: "noop", output: null } },
      ]),
    });

    runMigration(db, dbDir);

    const m3 = db
      .prepare(
        "SELECT tool_calls, tool_payload_migrated FROM messages WHERE id='m3'",
      )
      .get();
    check(
      "malformed row left byte-identical",
      m3.tool_calls === "{not json",
      m3.tool_calls,
    );
    check(
      "malformed row flagged so it cannot stall the backfill",
      m3.tool_payload_migrated === 1,
    );
    check(
      "null output stays inline so it round-trips",
      store.restoreSequencePayloads(
        readRow(db, "m4").sequence,
        readRow(db, "m4").toolCalls,
      )[0].data.output === null,
    );
    check(
      "nothing left pending",
      migration.countPendingPayloadMigrations(db) === 0,
    );

    // Rerunning must not double-offload or corrupt the stub.
    const beforeRerun = readRow(db, "m1");
    const rerun = runMigration(db, dbDir);
    const afterRerun = readRow(db, "m1");

    check("rerun processes nothing", rerun.rowsProcessed === 0);
    check(
      "rerun leaves the row byte-identical",
      JSON.stringify(beforeRerun) === JSON.stringify(afterRerun),
    );

    // A row written after the flag exists (new saves) is skipped too.
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, content, timestamp, tool_calls, sequence, tool_payload_migrated)
       VALUES ('m5','c1','assistant','x',?,NULL,NULL,1)`,
    ).run(new Date().toISOString());
    check(
      "already-migrated rows are not revisited",
      migration.countPendingPayloadMigrations(db) === 0,
    );

    db.close();
  }

  section("Forced re-migration is idempotent");
  {
    const dbDir = path.join(tmp, "case-5");
    fs.mkdirSync(dbDir);
    const db = createDb(dbDir);

    const huge = "I".repeat(OFFLOAD_THRESHOLD_CHARS + 3_000);
    insert(db, legacyRow({ id: "m1", chatId: "c1", results: [huge, "tail"] }));

    runMigration(db, dbDir);
    const first = readRow(db, "m1");

    // Simulate an interrupted run that flagged nothing: clear and redo.
    db.prepare("UPDATE messages SET tool_payload_migrated = 0").run();
    runMigration(db, dbDir);
    const second = readRow(db, "m1");

    check(
      "second pass changes nothing",
      JSON.stringify(first) === JSON.stringify(second),
    );
    check(
      "payload still intact after two passes",
      store.readOffloadedResult(dbDir, second.toolCalls[0].resultOffload) === huge,
    );

    db.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
