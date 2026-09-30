/**
 * Before/after for migration naming (audit bug 5).
 *
 * BEFORE: two collaborators independently write `0003_add_notes.sql` —
 * identical filename, different SQL. Ledger keys on filename, so the second
 * one is treated as already applied and silently never runs.
 *
 * AFTER: new migrations are `NNNN_YYYYMMDDHHMMSS_name.sql`. Filenames can no
 * longer collide, ordering stays number-first (old files keep their place),
 * and every existing string-sorted consumer (apply order, schema gate max id,
 * push-conflict rebase check) behaves the same.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDatabaseMigrations } from "../src/gateway/services/jobs/databaseMigrations.js";
import { maxExecutableMigrationId } from "../src/gateway/services/jobs/migrationLedgerPolicy.js";
import { detectMigrationPushConflict } from "../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js";

let root: string;
let dbPath: string;

function writeMigration(name: string, sql: string): void {
  fs.writeFileSync(path.join(root, "migrations", name), sql);
}

function columns(table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

function ledger(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mig-naming-"));
  fs.mkdirSync(path.join(root, "migrations"));
  dbPath = path.join(root, "data.db");
  writeMigration("0001_init.sql", "CREATE TABLE t (id INTEGER PRIMARY KEY);");
  writeMigration("0002_add_title.sql", "ALTER TABLE t ADD COLUMN title TEXT;");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BEFORE — number-only names collide", () => {
  it("B's 0003_add_notes.sql silently shadows A's different 0003_add_notes.sql", async () => {
    // B applied their own 0003 locally.
    writeMigration("0003_add_notes.sql", "ALTER TABLE t ADD COLUMN notes INTEGER;");
    await applyDatabaseMigrations(root, dbPath, { bypassReplicaEngine: true });

    // A's 0003_add_notes.sql (adds `priority` too) arrives with the same name.
    writeMigration("0003_add_notes.sql", "ALTER TABLE t ADD COLUMN notes TEXT; ALTER TABLE t ADD COLUMN priority INTEGER;");
    const appliedNow = await applyDatabaseMigrations(root, dbPath, { bypassReplicaEngine: true });

    expect(appliedNow).toEqual([]); // ledger says "0003_add_notes" already done
    expect(columns("t")).not.toContain("priority"); // A's change never lands on B
  });
});

describe("AFTER — number + timestamp names", () => {
  const A = "0003_20260924101500_add_notes.sql";
  const B = "0003_20260924101712_add_notes.sql";

  it("same number from two users → distinct files, both apply, deterministic order", async () => {
    writeMigration(A, "ALTER TABLE t ADD COLUMN notes TEXT;");
    writeMigration(B, "ALTER TABLE t ADD COLUMN priority INTEGER;");

    const applied = await applyDatabaseMigrations(root, dbPath, { bypassReplicaEngine: true });

    expect(applied.map((f) => f.replace(/\.sql$/, ""))).toEqual([
      "0001_init",
      "0002_add_title",
      A.replace(/\.sql$/, ""),
      B.replace(/\.sql$/, ""),
    ]);
    expect(columns("t")).toEqual(expect.arrayContaining(["notes", "priority"]));
    expect(ledger().filter((id) => id !== "0001_baseline")).toHaveLength(4);
  });

  it("old numbered files keep their order; new files sort by number then timestamp", () => {
    const ids = [
      "0004_20260101000000_later_number",
      B,
      "0002_add_title",
      A,
      "0001_init",
      "0003_legacy_no_timestamp",
    ].sort();
    expect(ids).toEqual([
      "0001_init",
      "0002_add_title",
      A,
      B,
      "0003_legacy_no_timestamp",
      "0004_20260101000000_later_number",
    ]);
  });

  it("schema gate (requiredSchemaVersion) picks the newest migration", () => {
    expect(maxExecutableMigrationId(["0001_init", "0002_add_title", A, B])).toBe(B);
  });

  it("push-conflict rebase check still fires when cloud is ahead", () => {
    // Cloud already has A's later-numbered migration; B's local one sorts before it.
    const conflict = detectMigrationPushConflict(
      ["0001_init", "0002_add_title", "0003_20260924120000_b_local"],
      ["0001_init", "0002_add_title", "0004_20260924110000_a_cloud"],
    );
    expect(conflict?.cloudAheadIds).toEqual(["0003_20260924120000_b_local"]);

    // No conflict when local sorts after everything on cloud.
    expect(
      detectMigrationPushConflict(
        ["0001_init", "0002_add_title", "0004_20260924110000_a_cloud", "0005_20260924130000_b_local"],
        ["0001_init", "0002_add_title", "0004_20260924110000_a_cloud"],
      ),
    ).toBeNull();
  });
});
