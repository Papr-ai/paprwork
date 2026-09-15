import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildJobCapabilityCard,
  isJobSystemTable,
  jobCapabilitySourceKey,
  readJobReliability,
  readJobTableShapes,
} from "../src/gateway/services/jobCapabilityCard.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

/**
 * Regression guards for the job-memory duplication defect.
 *
 * Measured before this change (Parse census 2026-09-11):
 *   5,721 rows / 26,488,636 chars / 6.1% of one namespace, 18% exact dupes,
 *   and the "Calendar Reader" job stored _papr_sync_log but never
 *   calendar_events.
 */

const job: JobRecord = {
  id: "40407339-ca0b-4650-a009-426201025e81",
  name: "Calendar Reader",
  type: "bash",
  status: "completed",
  appIds: ["6e432b37-6cf2-45f1-9ad8-ec70a56d4a3c"],
  command: "bash run_calendar.sh",
  schedule: { enabled: true, cron: "*/15 * * * *" },
} as JobRecord;

describe("system table exclusion", () => {
  test("excludes replication plumbing that previously ate the table budget", () => {
    for (const name of [
      "_papr_sync_log",
      "_papr_materialized",
      "_papr_oplog",
      "__turso_internal_seq",
      "sqlite_sequence",
      "job_runs",
    ]) {
      expect(isJobSystemTable(name)).toBe(true);
    }
  });

  test("keeps real job output", () => {
    for (const name of ["calendar_events", "briefs", "meetings", "app_files"]) {
      expect(isJobSystemTable(name)).toBe(false);
    }
  });
});

describe("readJobTableShapes", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-jobcard-"));
    dbPath = path.join(dir, "data.db");
    const db = new Database(dbPath);
    // Reproduce the real Calendar Reader shape: six plumbing tables that sort
    // BEFORE the payload table alphabetically.
    db.exec(`
      CREATE TABLE _papr_materialized (replica_id TEXT, seq INTEGER);
      CREATE TABLE _papr_oplog (replica_id TEXT, seq INTEGER);
      CREATE TABLE _papr_schema_migrations (id TEXT);
      CREATE TABLE _papr_sync_log (id INTEGER, table_name TEXT);
      CREATE TABLE _papr_sync_meta (id TEXT);
      CREATE TABLE _papr_sync_mute (id TEXT);
      CREATE TABLE app_file_hashes (local_path TEXT);
      CREATE TABLE app_files (id TEXT);
      CREATE TABLE calendar_events (id TEXT, title TEXT, start TEXT, "end" TEXT, attendees TEXT);
      CREATE TABLE empty_table (id TEXT);
    `);
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO _papr_sync_log VALUES (?, ?)").run(i, "calendar_events");
    }
    for (let i = 0; i < 12; i++) {
      db.prepare(
        'INSERT INTO calendar_events VALUES (?, ?, ?, ?, ?)',
      ).run(`e${i}`, `Meeting ${i}`, "2026-09-15", "2026-09-15", "a@b.com");
    }
    db.prepare("INSERT INTO app_files VALUES (?)").run("f1");
    db.close();
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("THE REGRESSION: calendar_events is present, plumbing is gone", () => {
    const names = readJobTableShapes(dbPath).map((t) => t.table);
    expect(names).toContain("calendar_events");
    expect(names.some((n) => n.startsWith("_papr_"))).toBe(false);
  });

  test("omits empty tables — an empty table is not a capability", () => {
    expect(readJobTableShapes(dbPath).map((t) => t.table)).not.toContain(
      "empty_table",
    );
  });

  test("orders by row count so the real payload leads", () => {
    const shapes = readJobTableShapes(dbPath);
    expect(shapes[0].table).toBe("calendar_events");
  });

  test("captures columns without reading row data", () => {
    const events = readJobTableShapes(dbPath).find(
      (t) => t.table === "calendar_events",
    );
    expect(events?.columns).toEqual(["id", "title", "start", "end", "attendees"]);
  });

  test("returns [] for a missing database rather than throwing", () => {
    expect(readJobTableShapes(path.join(dir, "nope.db"))).toEqual([]);
  });
});

describe("buildJobCapabilityCard", () => {
  const tables = [
    {
      table: "calendar_events",
      rowCount: 312,
      columns: ["id", "title", "start", "end", "attendees"],
    },
  ];

  test("THE COST FIX: identical inputs produce byte-identical output", () => {
    // The old snapshot embedded `Run ID:` and the old summary embedded the
    // sync date, so every run hashed differently and wrote again. If this
    // assertion ever fails, unbounded growth is back.
    const a = buildJobCapabilityCard({ job, tables });
    const b = buildJobCapabilityCard({ job, tables });
    expect(a).toBe(b);
  });

  test("contains no date and no run id", () => {
    const card = buildJobCapabilityCard({ job, tables });
    expect(card).not.toMatch(/Run ID/i);
    expect(card).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("states purpose, cadence and real output tables", () => {
    const card = buildJobCapabilityCard({ job, tables });
    expect(card).toContain("Calendar Reader");
    expect(card).toContain("*/15 * * * *");
    expect(card).toContain("calendar_events");
    expect(card).toContain("attendees");
  });

  test("derives search topics so a name-blind query can match", () => {
    const card = buildJobCapabilityCard({ job, tables });
    expect(card).toMatch(/Topics:.*calendar/);
  });

  test("bands reliability instead of writing an exact percentage", () => {
    // An exact percentage would change almost every run and break the
    // stable-hash property above.
    const card = buildJobCapabilityCard({
      job,
      tables,
      successRate: 0.96,
      runSampleSize: 50,
    });
    expect(card).toContain("reliable");
    expect(card).not.toContain("96");
  });

  test("stays small — the whole point is cost", () => {
    expect(buildJobCapabilityCard({ job, tables }).length).toBeLessThan(1000);
  });

  test("handles a job with no tables", () => {
    expect(buildJobCapabilityCard({ job, tables: [] })).toContain(
      "no persisted tables",
    );
  });

  test("source key is stable and unique per job", () => {
    expect(jobCapabilitySourceKey(job.id)).toBe(`job:${job.id}/capability`);
  });
});

describe("readJobReliability", () => {
  let dir: string;
  let dbPath: string;

  function seed(statuses: string[]): void {
    const db = new Database(dbPath);
    db.exec("DROP TABLE IF EXISTS job_runs");
    db.exec(
      `CREATE TABLE job_runs (id TEXT PRIMARY KEY, job_id TEXT, status TEXT,
       started_at TEXT, completed_at TEXT, exit_code INTEGER, error TEXT)`,
    );
    statuses.forEach((s, i) => {
      db.prepare(
        "INSERT INTO job_runs (id, job_id, status, started_at) VALUES (?,?,?,?)",
      ).run(`r${i}`, job.id, s, `2026-09-${String(i + 1).padStart(2, "0")}`);
    });
    db.close();
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-jobrel-"));
    dbPath = path.join(dir, "data.db");
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("computes success rate over recent runs", () => {
    seed([...Array(48).fill("completed"), "failed", "failed"]);
    const r = readJobReliability(dbPath);
    expect(r?.runSampleSize).toBe(50);
    expect(r?.successRate).toBeCloseTo(0.96, 2);
  });

  test("returns undefined for a sample too small to mean anything", () => {
    // 1 of 1 failing is not "flaky" — an unsupported claim is worse than none.
    seed(["failed"]);
    expect(readJobReliability(dbPath)).toBeUndefined();
  });

  test("ignores in-flight runs", () => {
    seed([...Array(10).fill("completed"), "running", "pending"]);
    expect(readJobReliability(dbPath)?.runSampleSize).toBe(10);
  });

  test("returns undefined when the job has no job_runs table", () => {
    const bare = path.join(dir, "bare.db");
    new Database(bare).close();
    expect(readJobReliability(bare)).toBeUndefined();
  });

  test("banding keeps the card hash stable as the rate drifts", () => {
    // THE POINT: an exact percentage would change on nearly every run and
    // rewrite the memory each time. Two different rates in the same band must
    // produce identical card text.
    const tables = [{ table: "t", rowCount: 5, columns: ["id"] }];
    const a = buildJobCapabilityCard({
      job,
      tables,
      successRate: 0.96,
      runSampleSize: 50,
    });
    const b = buildJobCapabilityCard({
      job,
      tables,
      successRate: 0.98,
      runSampleSize: 50,
    });
    expect(a).toBe(b);
  });

  test("a band change DOES alter the card, so real degradation surfaces", () => {
    const tables = [{ table: "t", rowCount: 5, columns: ["id"] }];
    const healthy = buildJobCapabilityCard({
      job,
      tables,
      successRate: 0.96,
      runSampleSize: 50,
    });
    const broken = buildJobCapabilityCard({
      job,
      tables,
      successRate: 0.4,
      runSampleSize: 50,
    });
    expect(healthy).not.toBe(broken);
    expect(broken).toContain("flaky");
  });
});
