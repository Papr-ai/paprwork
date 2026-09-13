/**
 * Recompute `messages.cost` with the corrected cache arithmetic (Issue 90).
 *
 * The old formula charged the provider's reported prompt total at 1.0× and then
 * added the cache read/write surcharges, double-charging every cached token.
 * This rewrites the stored figure using `calculateCostWithCache`, imported from
 * live source so the script can never drift from the shipped pricing.
 *
 * Only rows in the *inclusive* branch change — where `prompt_tokens` already
 * contains the cached portion. Rows with no cache tokens compute identically,
 * and rows corrupted by Issue 85 (`prompt_tokens` overwritten by a
 * continuation's smaller total while the cache figures kept accumulating) take
 * the exclusive branch, which reproduces the old value exactly. Those rows are
 * counted and reported: their token data is internally inconsistent, so no
 * formula recovers the truth and this script deliberately leaves them alone.
 *
 * Dry run by default. Pass --apply to write; --undo reverses it.
 *
 *   node --import tsx scripts/recompute-message-costs.ts
 *   node --import tsx scripts/recompute-message-costs.ts --apply
 *   node --import tsx scripts/recompute-message-costs.ts --undo
 *   node --import tsx scripts/recompute-message-costs.ts --db=/path/to/chats.db
 */

// `node:sqlite`, not better-sqlite3: that module is built for Electron's ABI
// (NODE_MODULE_VERSION 143) and will not load under plain node, so using it
// here would mean either an Electron harness or a rebuild that breaks the app.
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { calculateCostWithCache } from "../src/gateway/services/CostCalculation.js";

/** Cent-level tolerance; below this a difference is float noise, not a change. */
const EPSILON = 1e-9;

/** Rows per transaction — keeps a single lock hold short on a multi-GB file. */
const CHUNK_SIZE = 500;

/**
 * Reversal is an undo journal of the rows actually touched, not a copy of the
 * file. These databases total 6.4GB, and a whole-file copy would also roll back
 * any unrelated write the app made in between — the journal reverses precisely
 * what this script changed and nothing else.
 */
const UNDO_SUFFIX = ".cost-backfill-undo.json";

interface UndoJournal {
  database: string;
  generatedAt: string;
  rows: Array<{ id: string; cost: number }>;
}

interface CostRow {
  id: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost: number;
}

interface Outcome {
  scanned: number;
  changed: number;
  storedTotal: number;
  recomputedTotal: number;
  /** Issue 85 rows: cache figures exceed the reported prompt total. */
  incoherent: number;
  /** Skipped because the recomputed value was not a usable positive number. */
  skippedUnpriced: number;
  perModel: Map<string, { rows: number; stored: number; recomputed: number }>;
}

function discoverDatabases(): string[] {
  const root = path.join(homedir(), ".paprwork-v2");
  const found: string[] = [];

  const legacy = path.join(root, "chats.db");
  if (existsSync(legacy)) found.push(legacy);

  const orgsDir = path.join(root, "orgs");
  if (!existsSync(orgsDir)) return found;

  for (const org of readdirSync(orgsDir)) {
    const namespaces = path.join(orgsDir, org, "namespaces");
    if (!existsSync(namespaces) || !statSync(namespaces).isDirectory()) continue;
    for (const ns of readdirSync(namespaces)) {
      const db = path.join(namespaces, ns, "chats.db");
      if (existsSync(db)) found.push(db);
    }
  }

  return found;
}

/**
 * The corrected formula can only remove a charge, never add one, so a
 * recomputed value above the stored one means the inputs or the pricing table
 * are not what this script assumes. Abort rather than write in that case —
 * a backfill that can inflate a cost is worse than no backfill.
 */
function assertNeverIncreases(row: CostRow, recomputed: number): void {
  if (recomputed > row.cost + EPSILON) {
    throw new Error(
      `Refusing to write: recomputed cost ${recomputed} exceeds stored ${row.cost} ` +
        `for message ${row.id} (model ${row.model}). The corrected arithmetic ` +
        `should only ever reduce a cost.`,
    );
  }
}

function recompute(dbPath: string, apply: boolean): Outcome {
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  db.exec("PRAGMA busy_timeout = 10000");

  const outcome: Outcome = {
    scanned: 0,
    changed: 0,
    storedTotal: 0,
    recomputedTotal: 0,
    incoherent: 0,
    skippedUnpriced: 0,
    perModel: new Map(),
  };

  // Named scalar columns only — `SELECT *` would pull the tool payload columns
  // into the heap just to discard them (Issue 70).
  const rows = db
    .prepare(
      `SELECT id, model, prompt_tokens, completion_tokens,
              cache_read_tokens, cache_write_tokens, cost
         FROM messages
        WHERE role = 'assistant'
          AND cost IS NOT NULL AND cost > 0
          AND COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) > 0`,
    )
    .all() as CostRow[];

  const pending: Array<{ id: string; cost: number; previous: number }> = [];

  for (const row of rows) {
    outcome.scanned += 1;
    outcome.storedTotal += row.cost;

    const cacheRead = row.cache_read_tokens ?? 0;
    const cacheWrite = row.cache_write_tokens ?? 0;
    const promptTokens = row.prompt_tokens ?? 0;

    if (promptTokens < cacheRead + cacheWrite) {
      outcome.incoherent += 1;
    }

    if (!row.model) {
      outcome.skippedUnpriced += 1;
      outcome.recomputedTotal += row.cost;
      continue;
    }

    const recomputed = calculateCostWithCache(row.model, {
      promptTokens,
      completionTokens: row.completion_tokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    });

    // An unpriced model returns 0. Writing that would destroy a real figure.
    if (!Number.isFinite(recomputed) || recomputed <= 0) {
      outcome.skippedUnpriced += 1;
      outcome.recomputedTotal += row.cost;
      continue;
    }

    assertNeverIncreases(row, recomputed);
    outcome.recomputedTotal += recomputed;

    if (Math.abs(recomputed - row.cost) <= EPSILON) continue;

    outcome.changed += 1;
    pending.push({ id: row.id, cost: recomputed, previous: row.cost });

    // Changed rows only. Accumulating every row for the model would dilute the
    // overstatement factor toward 1.0× and imply far more rows changed than did.
    const stats = outcome.perModel.get(row.model) ?? {
      rows: 0,
      stored: 0,
      recomputed: 0,
    };
    stats.rows += 1;
    stats.stored += row.cost;
    stats.recomputed += recomputed;
    outcome.perModel.set(row.model, stats);
  }

  if (apply && pending.length > 0) {
    const journal: UndoJournal = {
      database: dbPath,
      generatedAt: new Date().toISOString(),
      rows: pending.map((entry) => ({ id: entry.id, cost: entry.previous })),
    };
    writeFileSync(`${dbPath}${UNDO_SUFFIX}`, JSON.stringify(journal, null, 2));
    console.log(`  undo journal -> ${dbPath}${UNDO_SUFFIX}`);

    const update = db.prepare(`UPDATE messages SET cost = ? WHERE id = ?`);
    for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
      const chunk = pending.slice(i, i + CHUNK_SIZE);
      db.exec("BEGIN");
      try {
        for (const entry of chunk) update.run(entry.cost, entry.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  db.close();
  return outcome;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function undo(dbPath: string): void {
  const journalPath = `${dbPath}${UNDO_SUFFIX}`;
  if (!existsSync(journalPath)) {
    console.log(`\n${dbPath}\n  no undo journal, nothing to restore`);
    return;
  }

  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as UndoJournal;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  const update = db.prepare(`UPDATE messages SET cost = ? WHERE id = ?`);

  db.exec("BEGIN");
  try {
    for (const row of journal.rows) update.run(row.cost, row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.close();

  console.log(
    `\n${dbPath}\n  restored ${journal.rows.length} rows from ${journal.generatedAt}`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const restore = args.includes("--undo");
  const explicit = args
    .filter((arg) => arg.startsWith("--db="))
    .map((arg) => arg.slice("--db=".length));

  const databases = explicit.length > 0 ? explicit : discoverDatabases();
  if (databases.length === 0) {
    console.error("No chats.db found. Pass --db=<path>.");
    process.exit(1);
  }

  if (restore) {
    console.log("RESTORING original costs from undo journals\n");
    for (const dbPath of databases) undo(dbPath);
    return;
  }

  console.log(apply ? "APPLYING changes\n" : "DRY RUN — pass --apply to write\n");

  let totalChanged = 0;
  let totalStored = 0;
  let totalRecomputed = 0;

  for (const dbPath of databases) {
    const outcome = recompute(dbPath, apply);
    totalChanged += outcome.changed;
    totalStored += outcome.storedTotal;
    totalRecomputed += outcome.recomputedTotal;

    console.log(`\n${dbPath}`);
    console.log(`  rows with cache tokens : ${outcome.scanned}`);
    console.log(`  rows changed           : ${outcome.changed}`);
    console.log(
      `  unchanged (Issue 85)   : ${outcome.incoherent}  ` +
        `(cache figures exceed the reported prompt total — token data is ` +
        `inconsistent, no formula recovers the truth)`,
    );
    console.log(`  skipped (unpriced)     : ${outcome.skippedUnpriced}`);
    console.log(
      `  stored ${usd(outcome.storedTotal)} -> recomputed ${usd(outcome.recomputedTotal)}`,
    );

    const models = [...outcome.perModel.entries()].sort(
      (a, b) => b[1].stored - a[1].stored,
    );

    if (models.length > 0) {
      console.log("  changed rows by model:");
      for (const [model, s] of models) {
        const factor = s.recomputed > 0 ? s.stored / s.recomputed : 0;
        console.log(
          `    ${model.padEnd(20)} ${String(s.rows).padStart(5)} rows  ` +
            `${usd(s.stored).padStart(10)} -> ${usd(s.recomputed).padStart(9)}  ` +
            `(${factor.toFixed(1)}× overstated)`,
        );
      }
    }
  }

  console.log(
    `\nTotal across cache-bearing rows: ${totalChanged} would change, ` +
      `${usd(totalStored)} -> ${usd(totalRecomputed)}`,
  );
  if (!apply) console.log("Nothing written. Re-run with --apply.");
}

main();
