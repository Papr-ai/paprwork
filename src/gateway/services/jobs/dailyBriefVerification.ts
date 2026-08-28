/**
 * Post-run verification for bundled Home Daily Brief job.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { DEFAULT_HOME_DAILY_BRIEF_JOB_NAME } from "../defaultHomeBundle.js";
import type { JobRecord } from "./types.js";

export function isHomeDailyBriefJob(job: Pick<JobRecord, "id" | "name" | "appIds">): boolean {
  return job.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME;
}

export function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function verifyDailyBriefRowForToday(dbPath: string): {
  ok: boolean;
  message: string;
} {
  const today = todayUtcDateKey();
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      message: `Daily Brief database missing: ${dbPath}`,
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='briefs' LIMIT 1",
      )
      .get() as { name: string } | undefined;
    if (!table) {
      return { ok: false, message: 'Daily Brief table "briefs" does not exist' };
    }

    const row = db
      .prepare(
        "SELECT date, length(brief_json) AS jsonLen FROM briefs WHERE date = ? LIMIT 1",
      )
      .get(today) as { date: string; jsonLen: number } | undefined;

    if (!row || !row.jsonLen || row.jsonLen <= 0) {
      return {
        ok: false,
        message: `No brief row for today (${today}) in ${dbPath}`,
      };
    }

    return {
      ok: true,
      message: `Daily Brief row verified for ${today} (${row.jsonLen} bytes)`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Daily Brief verification failed: ${(err as Error).message}`,
    };
  } finally {
    db?.close();
  }
}

export async function verifyHomeDailyBriefJobWrite(
  job: JobRecord,
  resolveDbPath: (jobId: string) => Promise<string | null>,
): Promise<{ ok: boolean; message: string } | null> {
  if (!isHomeDailyBriefJob(job)) {
    return null;
  }
  const dbPath = await resolveDbPath(job.id);
  if (!dbPath) {
    return { ok: false, message: "Daily Brief job database path unavailable" };
  }
  return verifyDailyBriefRowForToday(dbPath);
}
