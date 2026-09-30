/**
 * Turso database short names — one cloud DB per linked job (mirrors local data.db).
 *
 * Full Turso name: p-{org8}-{ns8}-{user8}-{shortName}
 * Example: job `de1a89d8-....` → short name `j-de1a89d8`
 */

/** Legacy shared user database (prefixed tables). Read-only during migration. */
export const LEGACY_USER_TURSO_DATABASE = "data";

/** Workspace index DB — one row per linked data replica short name. */
export const SYNC_INDEX_TURSO_SHORT_NAME = "sync-index";

/** Short Turso database name for a linked job's data.db replica. */
export function jobTursoDatabaseName(jobId: string): string {
  const hex = jobId.replace(/-/g, "").slice(0, 8).toLowerCase();
  return `j-${hex}`;
}

export function isJobTursoDatabaseName(name: string): boolean {
  return /^j-[a-f0-9]{8}$/.test(name);
}

export function isLegacyUserTursoDatabase(name: string): boolean {
  return name === LEGACY_USER_TURSO_DATABASE;
}

/** Short Turso database name for a standalone registry database. */
export function dbTursoDatabaseName(dbId: string): string {
  const hex = dbId.replace(/^db-/, "").replace(/-/g, "").slice(0, 8).toLowerCase();
  return `d-${hex}`;
}

export function isDbTursoDatabaseName(name: string): boolean {
  return /^d-[a-f0-9]{8}$/.test(name);
}

/** Resolve Turso short name from job/db change notification fields. */
export function tursoShortNameForChangeInput(input: {
  jobId?: string;
  dbId?: string;
  tursoShortName?: string;
}): string | undefined {
  const explicit = input.tursoShortName?.trim();
  if (explicit) {
    return explicit;
  }
  const dbId = input.dbId?.trim();
  if (dbId) {
    return dbTursoDatabaseName(dbId);
  }
  const jobId = input.jobId?.trim();
  if (jobId) {
    return jobTursoDatabaseName(jobId);
  }
  return undefined;
}

export interface TursoShortNameInput {
  dbId: string;
  tursoShortName?: string;
  ownerJobId?: string;
  isolation?: "shared" | "per-user";
}

/**
 * Resolve Turso short name from registry record fields.
 * Per-user isolation appends `-u-{userId8}`.
 */
export function resolveTursoShortName(
  record: TursoShortNameInput,
  userId?: string,
  isolationOverride?: "shared" | "per-user",
): string {
  const isolation = isolationOverride ?? record.isolation ?? "shared";
  let base: string;
  if (record.tursoShortName) {
    base = record.tursoShortName;
  } else if (record.ownerJobId) {
    base = jobTursoDatabaseName(record.ownerJobId);
  } else {
    base = dbTursoDatabaseName(record.dbId);
  }

  if (isolation === "per-user" && userId) {
    const uid8 = userId.replace(/-/g, "").slice(0, 8).toLowerCase();
    return `${base}-u-${uid8}`;
  }
  return base;
}
