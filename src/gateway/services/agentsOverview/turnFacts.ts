/**
 * turn_facts: one small row per billed assistant turn, holding everything the
 * Agents page needs from that turn's tool calls.
 *
 * `messages.tool_calls` averages ~130KB a row (args carry whole file bodies).
 * Unpacking it on every page open cost ~1s for 30 days and grew with history.
 * Instead each turn is unpacked exactly once, here, and the page reads these
 * rows plus the plain numeric columns on `messages`.
 *
 * "Exactly once" is a property of the data, not of a flag:
 *   - A turn needs a fact row iff it has none, or its row is older than
 *     FACTS_VERSION. That is one anti-join on the primary key.
 *   - Rows are written with INSERT OR REPLACE keyed by message_id, so running
 *     the fill twice (two windows, a crash mid-batch, a race with a new turn)
 *     writes the same row again instead of a duplicate.
 *   - When nothing matches the anti-join the fill is a no-op; there is no
 *     "done" marker that could get out of sync with the table.
 * Changing what a fact means? Bump FACTS_VERSION and old rows refill once.
 */

import type Database from "better-sqlite3";
import { inferTurnTargets } from "../storage/turnAttribution.js";

export const FACTS_VERSION = 1;

export function migrateTurnFactsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_facts (
      message_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      tools TEXT,
      bash_intents TEXT,
      app_id TEXT,
      repo TEXT,
      has_edit INTEGER NOT NULL DEFAULT 0,
      has_test INTEGER NOT NULL DEFAULT 0,
      has_build INTEGER NOT NULL DEFAULT 0,
      has_data INTEGER NOT NULL DEFAULT 0
    )
  `);
}

const SAFE_CALLS = `json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END)`;

/**
 * Turns still missing a current fact row, newest first so the default
 * 30-day window is complete before older history. Runs on the read worker.
 */
export const MISSING_FACTS_SQL = `
  SELECT m.id,
         (SELECT group_concat(json_extract(j.value, '$.name'), ',') FROM ${SAFE_CALLS} j) AS tools,
         (SELECT group_concat(
            COALESCE(json_extract(j.value, '$.args.path'), '') || ' ' ||
            COALESCE(json_extract(j.value, '$.args.cwd'), '') || ' ' ||
            COALESCE(json_extract(j.value, '$.args.appId'), '') || ' ' ||
            substr(COALESCE(json_extract(j.value, '$.args.command'), ''), 1, 300), char(10))
          FROM ${SAFE_CALLS} j) AS targets,
         (SELECT group_concat(substr(json_extract(j.value, '$.args.command'), 1, 160), char(30))
          FROM ${SAFE_CALLS} j WHERE json_extract(j.value, '$.name') = 'bash') AS bash
  FROM messages m
  LEFT JOIN turn_facts f ON f.message_id = m.id
  WHERE m.role = 'assistant' AND COALESCE(m.prompt_tokens, 0) > 0
    AND m.timestamp >= ?
    AND (f.message_id IS NULL OR f.version < ${FACTS_VERSION})
  ORDER BY m.timestamp DESC
  LIMIT ?`;

export const COUNT_MISSING_FACTS_SQL = `
  SELECT COUNT(*) AS n
  FROM messages m
  LEFT JOIN turn_facts f ON f.message_id = m.id
  WHERE m.role = 'assistant' AND COALESCE(m.prompt_tokens, 0) > 0
    AND m.timestamp >= ?
    AND (f.message_id IS NULL OR f.version < ${FACTS_VERSION})`;

export interface RawTurnCalls {
  id: string;
  tools: string | null;
  targets: string | null;
  bash: string | null;
}

export interface TurnFact {
  messageId: string;
  tools: string;
  bashIntents: Record<string, number>;
  appId: string | null;
  repo: string | null;
  hasEdit: boolean;
  hasTest: boolean;
  hasBuild: boolean;
  hasData: boolean;
}

export const BASH_INTENTS: Array<[string, RegExp]> = [
  ["sqlite", /\bsqlite3\b/],
  ["curl", /\bcurl\s/],
  ["git", /(^|[\s;&|(])(git|gh)\s/],
  ["Build / test", /\b(npm|npx|pnpm|yarn|tsc|vitest|esbuild|jest|pytest)\b/],
  ["Scripts", /\b(python3?|node|tsx|deno|bun)\s/],
  ["Search", /(^|[\s;&|(])(rg|grep|find|fd|ag)\s/],
  ["Read files", /(^|[\s;&|(])(sed -n|cat|head|tail|wc|less)\s/],
  ["List / navigate", /^\s*(ls|cd|pwd|tree)\b/],
];

export function bashIntent(command: string): string {
  const c = command.toLowerCase();
  for (const [label, re] of BASH_INTENTS) if (re.test(c)) return label;
  return "Other";
}

const EDIT_TOOLS = new Set(["edit_file", "write_file", "edit_app_file_lines", "edit_app_file"]);
const BUILD_TOOLS = new Set(["create_app"]);
const DATA_TOOLS = new Set(["create_job", "run_job", "update_job", "create_database", "attach_database"]);
const TEST_RE = /\b(npm|npx|pnpm|tsc|vitest|jest|pytest|esbuild)\b/;

/** Pure: the reduced tool-call strings for one turn → its fact row. */
export function computeTurnFact(raw: RawTurnCalls, paprRoot?: string): TurnFact {
  const names = (raw.tools ?? "").split(",").filter(Boolean);
  const bashIntents: Record<string, number> = {};
  for (const cmd of (raw.bash ?? "").split("\u001e").filter(Boolean)) {
    const k = bashIntent(cmd);
    bashIntents[k] = (bashIntents[k] ?? 0) + 1;
  }
  const { appId, repo } = inferTurnTargets((raw.targets ?? "").split("\n"), { paprRoot });
  return {
    messageId: raw.id,
    tools: names.join(","),
    bashIntents,
    appId,
    repo,
    hasEdit: names.some((n) => EDIT_TOOLS.has(n)),
    hasTest: TEST_RE.test(raw.bash ?? ""),
    hasBuild: names.some((n) => BUILD_TOOLS.has(n)),
    hasData: names.some((n) => DATA_TOOLS.has(n)),
  };
}

export function storeTurnFacts(db: Database.Database, facts: TurnFact[]): void {
  if (facts.length === 0) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO turn_facts
      (message_id, version, tools, bash_intents, app_id, repo, has_edit, has_test, has_build, has_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const f of facts) {
      stmt.run(
        f.messageId, FACTS_VERSION, f.tools || null,
        Object.keys(f.bashIntents).length ? JSON.stringify(f.bashIntents) : null,
        f.appId, f.repo, f.hasEdit ? 1 : 0, f.hasTest ? 1 : 0, f.hasBuild ? 1 : 0, f.hasData ? 1 : 0,
      );
    }
  })();
}
