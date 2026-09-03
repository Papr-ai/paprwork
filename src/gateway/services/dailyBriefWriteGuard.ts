/**
 * Reject invalid Daily Brief rows before they reach the Home dashboard DB.
 * Blocks agent debug writes (e.g. date=2026-09-02-test, brief_json={}).
 */

import {
  validateDailyBriefWrite,
} from "../../core/utils/dailyBriefPayload.js";
import type { AppDataSource } from "./appDataSources.js";
import {
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_BRIEFS_DB_SLUG,
} from "./defaultHomeBundle.js";

function normalizeSql(sql: string): string {
  return sql.trim().toLowerCase().replace(/\s+/g, " ");
}

function touchesBriefsTable(sql: string): boolean {
  const normalized = normalizeSql(sql);
  if (!/\bbriefs\b/.test(normalized)) {
    return false;
  }
  return (
    normalized.startsWith("insert") ||
    normalized.startsWith("replace") ||
    normalized.startsWith("update") ||
    normalized.startsWith("upsert")
  );
}

function extractBriefWriteParams(
  sql: string,
  params: unknown[] | undefined,
): { dateKey: unknown; briefJson: unknown } | null {
  if (!params?.length) {
    return null;
  }

  const normalized = normalizeSql(sql);

  if (
    (normalized.startsWith("insert") || normalized.startsWith("replace")) &&
    normalized.includes("brief_json") &&
    normalized.includes("date")
  ) {
    return { dateKey: params[0], briefJson: params[1] };
  }

  if (normalized.startsWith("update") && normalized.includes("brief_json")) {
    if (normalized.includes("where date")) {
      return {
        dateKey: params[params.length - 1],
        briefJson: params[0],
      };
    }
  }

  return null;
}

function isHomeBriefsSource(appId: string, source: AppDataSource): boolean {
  if (appId === DEFAULT_HOME_APP_ID) {
    return (source.tables ?? []).includes("briefs");
  }
  return source.dbPath.includes(`/data/databases/${DEFAULT_HOME_BRIEFS_DB_SLUG}/`);
}

export function assertValidHomeBriefWrite(
  appId: string,
  source: AppDataSource,
  sql: string,
  params?: unknown[],
): void {
  if (!isHomeBriefsSource(appId, source) || !touchesBriefsTable(sql)) {
    return;
  }

  const extracted = extractBriefWriteParams(sql, params);
  if (!extracted) {
    return;
  }

  const result = validateDailyBriefWrite(extracted.dateKey, extracted.briefJson);
  if (!result.ok) {
    const err = new Error(result.error) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}
