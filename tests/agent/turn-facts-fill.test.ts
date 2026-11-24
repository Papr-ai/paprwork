import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  COUNT_MISSING_FACTS_SQL,
  FACTS_VERSION,
  MISSING_FACTS_SQL,
  computeTurnFact,
  type RawTurnCalls,
  type TurnFact,
} from "../../src/gateway/services/agentsOverview/turnFacts.js";

/**
 * The fill must be once-only by construction: the anti-join finds a turn
 * only while it has no current fact row, and writes are keyed upserts.
 * node:sqlite stands in for better-sqlite3 (same SQL, no native rebuild).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => any };

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, timestamp TEXT, prompt_tokens INTEGER, tool_calls TEXT);
    CREATE TABLE turn_facts (message_id TEXT PRIMARY KEY, version INTEGER NOT NULL, tools TEXT, bash_intents TEXT,
      app_id TEXT, repo TEXT, has_edit INTEGER NOT NULL DEFAULT 0, has_test INTEGER NOT NULL DEFAULT 0,
      has_build INTEGER NOT NULL DEFAULT 0, has_data INTEGER NOT NULL DEFAULT 0);
  `);
  const add = db.prepare("INSERT INTO messages VALUES (?, 'assistant', ?, 10, ?)");
  for (let i = 0; i < 5; i += 1) {
    add.run(`m${i}`, `2026-10-0${i + 1}T00:00:00Z`, JSON.stringify([{ name: "bash", args: { command: "rg foo" } }]));
  }
  add.run("bad", "2026-10-09T00:00:00Z", "not json");
  const store = (facts: TurnFact[]) => {
    const st = db.prepare("INSERT OR REPLACE INTO turn_facts (message_id, version, tools) VALUES (?, ?, ?)");
    for (const f of facts) st.run(f.messageId, FACTS_VERSION, f.tools || null);
  };
  const fill = (batch: number) => {
    let n = 0;
    for (;;) {
      const raw = db.prepare(MISSING_FACTS_SQL).all("", batch) as unknown as RawTurnCalls[];
      if (raw.length === 0) return n;
      store(raw.map((r) => computeTurnFact(r)));
      n += raw.length;
    }
  };
  const missing = () => (db.prepare(COUNT_MISSING_FACTS_SQL).get("") as { n: number }).n;
  return { db, fill, missing };
}

describe("turn facts fill", () => {
  it("covers every turn, including malformed tool_calls, then finds nothing", () => {
    const { db, fill, missing } = setup();
    expect(missing()).toBe(6);
    expect(fill(2)).toBe(6);
    expect(missing()).toBe(0);
    expect(fill(2)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM turn_facts").get() as { n: number }).n).toBe(6);
  });

  it("an interrupted fill resumes where it stopped", () => {
    const { db, missing } = setup();
    const first = db.prepare(MISSING_FACTS_SQL).all("", 2) as RawTurnCalls[];
    const st = db.prepare("INSERT OR REPLACE INTO turn_facts (message_id, version) VALUES (?, ?)");
    for (const r of first) st.run(r.id, FACTS_VERSION);
    // process "crashes" here; next launch only sees the remaining 4
    expect(missing()).toBe(4);
    const next = (db.prepare(MISSING_FACTS_SQL).all("", 10) as RawTurnCalls[]).map((r) => r.id);
    expect(next).not.toContain(first[0].id);
    expect(next).toHaveLength(4);
  });

  it("refills rows written by an older version exactly once", () => {
    const { db, fill, missing } = setup();
    fill(10);
    db.exec(`UPDATE turn_facts SET version = ${FACTS_VERSION - 1} WHERE message_id IN ('m0','m1')`);
    expect(missing()).toBe(2);
    expect(fill(10)).toBe(2);
    expect(missing()).toBe(0);
  });
});
