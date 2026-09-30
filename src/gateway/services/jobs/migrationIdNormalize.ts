/**
 * Normalize migration ids for ledger comparison (strip .sql, dedupe markers).
 */

import { shouldSkipMigrationForRemoteLedger } from "./migrationLedgerPolicy.js";

export function normalizeMigrationId(migrationId: string): string {
  const trimmed = migrationId.trim();
  if (trimmed.toLowerCase().endsWith(".sql")) {
    return trimmed.slice(0, -4);
  }
  return trimmed;
}

/** Deduplicate and normalize migration ids for ledger operations. */
export function normalizeMigrationIdList(migrationIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of migrationIds) {
    const normalized = normalizeMigrationId(raw);
    if (!normalized || shouldSkipMigrationForRemoteLedger(normalized)) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort();
}
