/**
 * Regression tests for the scheduler retry storm caused by an unusable
 * app-linked database.
 *
 * `new Database(path)` only opens a file handle — SQLite does not read the
 * header until the first statement runs. So a linked file that is NOT a SQLite
 * database (truncated, overwritten with text, corrupt) opens fine and then
 * throws SQLITE_NOTADB from `db.prepare()` inside validation.
 *
 * That raw SqliteError escaped validateJobAgainstAppDatabase, so the scheduler
 * never recognised it as an architecture failure and never advanced nextRunAt.
 * The job stayed permanently due and relaunched on every tick:
 *
 *   [JobsScheduler] Scheduled run failed for fcb4a4e5-…: SqliteError: file is not a database
 *   [JobsScheduler] Tick completed in 48ms - enabled: 15, due: 1, launched: 1
 *
 * …several times per second, indefinitely, starving the gateway while cloud
 * sync was running.
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { validateJobAgainstAppDatabase } from "../src/gateway/services/jobs/jobDatabaseArchitectureValidation.js";

// The vendored better-sqlite3 is built for Electron's ABI. Under plain vitest
// it fails to load, which would make the "unusable database" tests pass for the
// wrong reason (every open fails, not just the corrupt ones). Gate the cases
// that need a real driver; the classification tests below always run.
let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "papr-unusable-db-"));
  dirs.push(dir);
  return dir;
}

/** A file that exists and opens, but is not a SQLite database. */
function notADatabase(contents: string): string {
  const dbPath = path.join(tempDir(), "data.db");
  writeFileSync(dbPath, contents);
  return dbPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Mirrors the scheduler's classification in JobsScheduler.tick(). */
function schedulerTreatsAsPermanent(error: unknown): boolean {
  const err = error instanceof Error ? error : new Error(String(error));
  const isUnusableDatabase =
    (error as { code?: string })?.code === "SQLITE_NOTADB" ||
    /file is not a database|database disk image is malformed|malformed database schema/i.test(
      err.message,
    );
  return (
    err.message.includes("Job architecture validation failed") ||
    isUnusableDatabase
  );
}

describe("validateJobAgainstAppDatabase with an unusable database", () => {
  it.skipIf(!canUseBetterSqlite)(
    "returns an issue instead of throwing for a non-SQLite file",
    () => {
      // The exact production shape: a Python one-liner written where a DB belongs.
      const dbPath = notADatabase(
        "print('Use sync_reminders.py and sync calendar.json')\n",
      );

      let issues: ReturnType<typeof validateJobAgainstAppDatabase> = [];
      expect(() => {
        issues = validateJobAgainstAppDatabase({
          databasePath: dbPath,
          command: `sqlite3 "$APP_DB" 'SELECT 1'`,
        });
      }).not.toThrow();

      expect(
        issues.some((issue) => issue.rule === "primary-database-unopenable"),
      ).toBe(true);
      expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "surfaces a remediation the user can act on",
    () => {
      const issues = validateJobAgainstAppDatabase({
        databasePath: notADatabase("not sqlite at all"),
        command: "python3 code/ingest.py",
      });
      const issue = issues.find(
        (i) => i.rule === "primary-database-unopenable",
      );
      expect(issue?.remediation).toMatch(/re-link|create_database/i);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "does not throw for a binary file with a corrupt SQLite header",
    () => {
      const dbPath = path.join(tempDir(), "data.db");
      // Valid-looking prefix, garbage after — opens, fails on first read.
      const buffer = Buffer.alloc(4096);
      buffer.write("SQLite format 3\0", 0, "utf8");
      buffer.fill(0xff, 16);
      writeFileSync(dbPath, buffer);

      expect(() =>
        validateJobAgainstAppDatabase({
          databasePath: dbPath,
          command: `sqlite3 "$APP_DB" 'SELECT 1'`,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "still validates healthy databases normally",
    () => {
      const dbPath = path.join(tempDir(), "data.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT)");
      db.close();

      // Sanity: the new try/catch must not swallow real schema drift.
      const drift = validateJobAgainstAppDatabase({
        databasePath: dbPath,
        command: `sqlite3 "$APP_DB" 'INSERT INTO missing_table(id) VALUES (1)'`,
      });
      expect(drift.some((i) => i.rule === "job-table-missing-on-primary")).toBe(
        true,
      );

      const clean = validateJobAgainstAppDatabase({
        databasePath: dbPath,
        command: `sqlite3 "$APP_DB" 'UPDATE runs SET status = ? WHERE id = 1'`,
      });
      expect(clean).toHaveLength(0);
    },
  );
});

describe("scheduler classifies unusable databases as permanent", () => {
  it("advances the schedule for a raw SQLITE_NOTADB error", () => {
    const error = Object.assign(new Error("file is not a database"), {
      code: "SQLITE_NOTADB",
    });
    expect(schedulerTreatsAsPermanent(error)).toBe(true);
  });

  it("advances the schedule for malformed-image and malformed-schema errors", () => {
    expect(
      schedulerTreatsAsPermanent(new Error("database disk image is malformed")),
    ).toBe(true);
    expect(
      schedulerTreatsAsPermanent(
        new Error("malformed database schema (_papr_tr_investors_au)"),
      ),
    ).toBe(true);
  });

  it("keeps treating architecture validation failures as permanent", () => {
    expect(
      schedulerTreatsAsPermanent(
        new Error("Job architecture validation failed: table missing"),
      ),
    ).toBe(true);
  });

  it("still retries genuinely transient failures", () => {
    // These must NOT advance the schedule — the job should run again next tick.
    expect(schedulerTreatsAsPermanent(new Error("fetch failed"))).toBe(false);
    expect(schedulerTreatsAsPermanent(new Error("database is locked"))).toBe(
      false,
    );
    expect(schedulerTreatsAsPermanent(new Error("ECONNRESET"))).toBe(false);
  });
});
