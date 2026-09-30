/**
 * Measure how wrong `chars/4` is on this machine's real chat content.
 *
 * The context estimator in `compactToolResults.ts` assumes 4 characters per
 * token. That assumption drives the compaction gate, the mid-turn trim and the
 * post-trim budget check, so if it is optimistic those all fire later than
 * their ratios imply. This tokenizes real stored payloads with a BPE tokenizer
 * and reports the true characters-per-token by content type.
 *
 * Read-only, aggregate-only: no payload text is printed, and the database is
 * opened read-only so it is safe to run while the app is up.
 *
 *   node scripts/calibrate-token-estimator.mjs [--chat <id-prefix>] [--limit 60]
 *
 * cl100k_base is an OpenAI tokenizer; Claude's differs somewhat but tracks it
 * closely enough on code and JSON for a calibration decision. Treat the result
 * as a floor on the error, not a precise figure.
 */

import { getEncoding } from "js-tiktoken";
import { DatabaseSync } from "node:sqlite";
import { existsSync, globSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const chatPrefix = flag("chat", "");
const limit = Number(flag("limit", "60"));

/**
 * Chat databases are namespace-scoped, and the unscoped root file is usually a
 * near-empty leftover from before that split. Pick the largest one so the
 * script finds real data without needing to know the active workspace.
 */
function resolveChatsDb() {
  const explicit = flag("db", "") || process.env.CHATS_DB;
  if (explicit) return explicit;

  const root = path.join(os.homedir(), ".paprwork-v2");
  const candidates = [
    ...globSync(path.join(root, "orgs", "*", "namespaces", "*", "chats.db")),
    path.join(root, "chats.db"),
  ].filter((candidate) => existsSync(candidate));

  if (candidates.length === 0) return path.join(root, "chats.db");

  return candidates.reduce((largest, candidate) =>
    statSync(candidate).size > statSync(largest).size ? candidate : largest,
  );
}

const dbPath = resolveChatsDb();
if (!existsSync(dbPath)) {
  console.error(`No chats database at ${dbPath}. Pass --db <path>.`);
  process.exit(1);
}

const enc = getEncoding("cl100k_base");
const db = new DatabaseSync(dbPath, { readOnly: true });

// Bounded by LENGTH so an offloaded multi-megabyte row is never pulled into
// the heap just to be sampled (see Issue 70).
const rows = db
  .prepare(
    `SELECT tool_calls, content FROM messages
     WHERE role = 'assistant'
       AND tool_calls IS NOT NULL
       AND LENGTH(tool_calls) < 400000
       AND json_valid(tool_calls)
       ${chatPrefix ? "AND chat_id LIKE ?" : ""}
     ORDER BY timestamp DESC
     LIMIT ?`,
  )
  .all(...(chatPrefix ? [`${chatPrefix}%`, limit] : [limit]));

const buckets = {
  "tool results": { chars: 0, tokens: 0, n: 0 },
  "tool arguments": { chars: 0, tokens: 0, n: 0 },
  "assistant prose": { chars: 0, tokens: 0, n: 0 },
};

function sample(bucket, value) {
  if (typeof value !== "string" || value.length === 0) return;
  // Cap per sample so one huge payload cannot dominate the ratio.
  const slice = value.slice(0, 200_000);
  buckets[bucket].chars += slice.length;
  buckets[bucket].tokens += enc.encode(slice).length;
  buckets[bucket].n += 1;
}

function asString(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

for (const row of rows) {
  sample("assistant prose", row.content);
  let calls;
  try {
    calls = JSON.parse(row.tool_calls);
  } catch {
    continue;
  }
  if (!Array.isArray(calls)) continue;
  for (const call of calls) {
    sample("tool arguments", asString(call?.args));
    sample("tool results", asString(call?.result));
  }
}

db.close();

let totalChars = 0;
let totalTokens = 0;

console.log(`\nSampled ${rows.length} assistant messages from ${dbPath}\n`);
console.log(
  "content type       samples        chars       tokens   chars/token   chars/4 error",
);
console.log("-".repeat(80));

for (const [name, bucket] of Object.entries(buckets)) {
  if (bucket.chars === 0) continue;
  totalChars += bucket.chars;
  totalTokens += bucket.tokens;
  const ratio = bucket.chars / bucket.tokens;
  console.log(
    name.padEnd(18) +
      String(bucket.n).padStart(7) +
      String(bucket.chars).padStart(13) +
      String(bucket.tokens).padStart(13) +
      ratio.toFixed(2).padStart(14) +
      `${(4 / ratio).toFixed(2)}x`.padStart(16),
  );
}

if (totalTokens === 0) {
  console.log("\nNo tool payloads found — nothing to calibrate.");
  process.exit(0);
}

const overall = totalChars / totalTokens;
console.log("-".repeat(80));
console.log(
  "OVERALL".padEnd(18) +
    "".padStart(7) +
    String(totalChars).padStart(13) +
    String(totalTokens).padStart(13) +
    overall.toFixed(2).padStart(14) +
    `${(4 / overall).toFixed(2)}x`.padStart(16),
);

console.log(
  `\nchars/4 error = how many times larger the real token count is than our estimate.` +
    `\nThis is only the ratio error. Tool-call arguments and JSON framing are` +
    `\ncounted separately; see turn_estimated_context_tokens vs` +
    `\nturn_peak_context_tokens on the messages table for the combined gap.\n`,
);
