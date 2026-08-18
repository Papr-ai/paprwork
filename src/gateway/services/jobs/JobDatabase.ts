import Database from "better-sqlite3";
import { promises as fs } from "fs";
import path from "path";
import {
  applyDatabaseMigrations,
  applySqlitePerformancePragmas,
} from "./databaseMigrations.js";

export class JobDatabase {
  private getDbPath(jobDir: string): string {
    return path.join(jobDir, "data", "data.db");
  }

  private async withDatabase<T>(
    jobDir: string,
    action: (db: Database.Database) => T,
  ): Promise<T | null> {
    const dbPath = this.getDbPath(jobDir);
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      return action(db);
    } catch {
      return null;
    } finally {
      if (db) {
        db.close();
      }
    }
  }

  /**
   * Ensure standard job folder layout exists before run/migrations.
   * Jobs indexed via synced jobs.json may have job.json only (no data/ yet).
   */
  async ensureJobDirScaffold(jobDir: string): Promise<string> {
    await fs.mkdir(path.join(jobDir, "code"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "logs"), { recursive: true });
    return this.ensureDatabase(jobDir);
  }

  async ensureDatabase(jobDir: string): Promise<string> {
    const dataDir = path.join(jobDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(path.join(jobDir, "migrations"), { recursive: true });
    const dbPath = this.getDbPath(jobDir);

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      applySqlitePerformancePragmas(db, 5000);
      
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS job_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          exit_code INTEGER,
          error TEXT
        );

        CREATE TABLE IF NOT EXISTS job_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
        CREATE INDEX IF NOT EXISTS idx_job_events_run_id ON job_events(run_id);
      `);

      db.prepare(`
        INSERT OR IGNORE INTO schema_migrations (id, applied_at)
        VALUES (?, ?)
      `).run("0001_baseline", new Date().toISOString());
    } catch {
      // Fallback for environments where native sqlite module isn't available.
      // Keep deterministic file structure so jobs remain portable/testable.
      await fs.writeFile(dbPath, "", { flag: "a" });
      const baselineMigration = path.join(
        jobDir,
        "migrations",
        "0001_baseline.sql",
      );
      await fs.writeFile(
        baselineMigration,
        "-- baseline schema created by fallback path\n",
        { flag: "a" },
      );
    } finally {
      if (db) {
        db.close();
      }
    }

    return dbPath;
  }

  async applyMigrations(jobDir: string): Promise<string[]> {
    return applyDatabaseMigrations(jobDir, this.getDbPath(jobDir));
  }

  async recordRunStart(
    jobDir: string,
    runId: string,
    jobId: string,
    startedAt: string,
  ): Promise<void> {
    await this.withDatabase(jobDir, (db) => {
      db.prepare(
        `INSERT OR REPLACE INTO job_runs (id, job_id, status, started_at)
         VALUES (?, ?, ?, ?)`,
      ).run(runId, jobId, "running", startedAt);
    });
  }

  async recordRunFinish(
    jobDir: string,
    runId: string,
    status: "completed" | "failed" | "cancelled",
    exitCode: number,
    errorMessage?: string,
  ): Promise<void> {
    await this.withDatabase(jobDir, (db) => {
      db.prepare(
        `UPDATE job_runs
         SET status = ?, completed_at = ?, exit_code = ?, error = ?
         WHERE id = ?`,
      ).run(
        status,
        new Date().toISOString(),
        exitCode,
        errorMessage ?? null,
        runId,
      );
    });
  }

  async appendEvent(
    jobDir: string,
    runId: string,
    level: "info" | "warn" | "error",
    message: string,
  ): Promise<void> {
    await this.withDatabase(jobDir, (db) => {
      db.prepare(
        `INSERT INTO job_events (run_id, ts, level, message)
         VALUES (?, ?, ?, ?)`,
      ).run(runId, new Date().toISOString(), level, message);
    });
  }

  async pruneHistory(jobDir: string, retentionDays: number): Promise<void> {
    if (retentionDays <= 0) {
      return;
    }
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.withDatabase(jobDir, (db) => {
      db.prepare(
        `DELETE FROM job_events
         WHERE run_id IN (
           SELECT id FROM job_runs WHERE started_at < ?
         )`,
      ).run(cutoff);
      db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(cutoff);
    });
  }
}
