/**
 * Post-run verification for bundled Home Daily Brief job.
 */

import { existsSync } from "fs";
import { todayBriefDateKey } from "../../../core/utils/briefDateKey.js";
import { parseDailyBriefPayload } from "../../../core/utils/dailyBriefPayload.js";
import { DEFAULT_HOME_DAILY_BRIEF_JOB_NAME } from "../defaultHomeBundle.js";
import {
  queryRegistryDatabase,
  type RegistryDbSchemaReadInput,
} from "./registryDbSchemaReader.js";
import type { JobRecord } from "./types.js";

export function isHomeDailyBriefJob(job: Pick<JobRecord, "id" | "name" | "appIds">): boolean {
  return job.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME;
}

/** @deprecated Use todayBriefDateKey from core — kept for tests importing this module. */
export function todayUtcDateKey(): string {
  return todayBriefDateKey();
}

export async function verifyDailyBriefRowForToday(
  dbPathOrContext: string | RegistryDbSchemaReadInput,
): Promise<{ ok: boolean; message: string }> {
  const db =
    typeof dbPathOrContext === "string"
      ? { dbPath: dbPathOrContext }
      : dbPathOrContext;
  const today = todayBriefDateKey();
  if (!existsSync(db.dbPath)) {
    return {
      ok: false,
      message: `Daily Brief database missing: ${db.dbPath}`,
    };
  }

  const tableCheck = await queryRegistryDatabase(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='briefs' LIMIT 1",
  );
  if (!tableCheck?.rows.length) {
    return { ok: false, message: 'Daily Brief table "briefs" does not exist' };
  }

  const rowResult = await queryRegistryDatabase(
    db,
    "SELECT date, brief_json FROM briefs WHERE date = ? LIMIT 1",
    [today],
  );
  const row = rowResult?.rows[0] as
    | { date?: string; brief_json?: string }
    | undefined;

  if (!row?.brief_json || !String(row.brief_json).trim()) {
    return {
      ok: false,
      message: `No brief row for today (${today}) in ${db.dbPath}`,
    };
  }

  const briefJson = String(row.brief_json);
  const payload = parseDailyBriefPayload(briefJson);
  if (!payload) {
    return {
      ok: false,
      message: `Brief row for ${today} is invalid (missing hero.title or sections)`,
    };
  }

  return {
    ok: true,
    message: `Daily Brief row verified for ${today} (${briefJson.length} bytes)`,
  };
}

export async function verifyHomeDailyBriefJobWrite(
  job: JobRecord,
  resolveDbPath: (jobId: string) => Promise<string | null>,
  resolveDbContext?: (
    jobId: string,
  ) => Promise<RegistryDbSchemaReadInput | null>,
): Promise<{ ok: boolean; message: string } | null> {
  if (!isHomeDailyBriefJob(job)) {
    return null;
  }

  const context = resolveDbContext ? await resolveDbContext(job.id) : null;
  if (context?.dbPath) {
    return verifyDailyBriefRowForToday(context);
  }

  const dbPath = await resolveDbPath(job.id);
  if (!dbPath) {
    return { ok: false, message: "Daily Brief job database path unavailable" };
  }
  return verifyDailyBriefRowForToday(dbPath);
}
