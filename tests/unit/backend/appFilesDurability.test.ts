/**
 * Durable-resume integration tests against a real SQLite database.
 *
 * The pure decisions are covered in uploadResume.test.ts. What matters here is
 * that they survive contact with an actual schema — including a database
 * created before durable resume existed.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ensureSchema,
  hashFileCached,
  type FilesDb,
} from "../../../src/gateway/services/appFiles/AppFilesService.js";

/** Adapter matching the FilesDb surface the service expects. */
function makeDb(): { db: FilesDb; raw: Database.Database } {
  const raw = new Database(":memory:");
  const db: FilesDb = {
    exec: (sql) => {
      raw.exec(sql);
    },
    run: (sql, params = []) => {
      const info = raw.prepare(sql).run(...(params as never[]));
      return { changes: info.changes };
    },
    all: <T,>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).all(...(params as never[])) as T[],
  };
  return { db, raw };
}

function columns(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name);
}

describe("ensureSchema", () => {
  it("creates the durability columns on a fresh database", async () => {
    const { db, raw } = makeDb();
    await ensureSchema(db);

    const cols = columns(raw, "app_files");
    expect(cols).toContain("upload_session_uri");
    expect(cols).toContain("bytes_uploaded");
    expect(cols).toContain("session_expires_at");
  });

  it("migrates a database created before durable resume", async () => {
    // The upgrade path that would otherwise break every existing install:
    // CREATE TABLE IF NOT EXISTS is a no-op once the old table exists, so the
    // new columns only appear if the ALTERs actually run.
    const { db, raw } = makeDb();
    raw.exec(`
      CREATE TABLE app_files (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, mime TEXT,
        file_name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'app',
        local_path TEXT, upload_state TEXT NOT NULL DEFAULT 'pending',
        visibility TEXT NOT NULL DEFAULT 'inherit',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare(
      `INSERT INTO app_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("f1", "app", "k1", "sha", 10, null, "a.mp4", "app", null,
      "verified", "inherit", 1, 1);

    await ensureSchema(db);

    expect(columns(raw, "app_files")).toContain("upload_session_uri");
    // The existing row must survive the migration untouched.
    const row = raw.prepare(`SELECT * FROM app_files WHERE id = 'f1'`).get() as {
      upload_state: string;
      bytes_uploaded: number;
    };
    expect(row.upload_state).toBe("verified");
    expect(row.bytes_uploaded).toBe(0);
  });

  it("is idempotent across repeated calls", async () => {
    // ensureSchema runs on every request; a second call must not throw
    // "duplicate column name".
    const { db } = makeDb();
    await ensureSchema(db);
    await expect(ensureSchema(db)).resolves.toBeUndefined();
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });
});

describe("hashFileCached", () => {
  it("hashes once and reuses the result for an untouched file", async () => {
    const { db, raw } = makeDb();
    await ensureSchema(db);

    const { mkdtemp, writeFile, stat, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "papr-hash-"));
    const file = join(dir, "big.bin");
    await writeFile(file, Buffer.alloc(4096, 3));
    const info = await stat(file);

    const first = await hashFileCached(db, file, info);
    const second = await hashFileCached(db, file, info);

    expect(second).toBe(first);
    // One cached row, and the second call served from it rather than
    // re-reading the file — the saving that matters at 10 GB.
    const cached = raw
      .prepare(`SELECT sha256 FROM app_file_hashes WHERE local_path = ?`)
      .all(file) as { sha256: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].sha256).toBe(first);

    await rm(dir, { recursive: true, force: true });
  });

  it("rehashes when the file changed underneath us", async () => {
    const { db } = makeDb();
    await ensureSchema(db);

    const { mkdtemp, writeFile, stat, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "papr-hash-"));
    const file = join(dir, "big.bin");

    await writeFile(file, Buffer.alloc(4096, 1));
    const first = await hashFileCached(db, file, await stat(file));

    await writeFile(file, Buffer.alloc(8192, 2));
    const second = await hashFileCached(db, file, await stat(file));

    expect(second).not.toBe(first);
    await rm(dir, { recursive: true, force: true });
  });
});
