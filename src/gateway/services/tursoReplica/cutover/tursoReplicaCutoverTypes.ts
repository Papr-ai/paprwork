/**
 * Plan A Phase 3 — legacy → replica cutover types.
 */

export type CutoverBucket =
  | "skip"
  | "cloud_off"
  | "seed_local"
  | "pull_remote"
  | "blocked";

export interface CutoverSnapshot {
  dbExists: boolean;
  localTableCount: number;
  remoteTableCount: number;
  schemaDrift: boolean;
  /** Local-only pre-_papr_* CDC tables (excluded from drift; stripped at cutover). */
  legacyArtifactTables: string[];
  remoteCheckFailed: boolean;
  dirty: boolean;
  quarantined: boolean;
  localMigrationIds: string[];
  remoteMigrationIds: string[];
  migrationConflict: boolean;
  migrationConflictReason?: string;
}

export interface CutoverClassification {
  dbId: string;
  bucket: CutoverBucket;
  reason: string;
  snapshot: CutoverSnapshot;
}

export interface CutoverRunResult {
  dbId: string;
  dryRun: boolean;
  classification: CutoverClassification;
  ok: boolean;
  skipped?: boolean;
  blocked?: boolean;
  backupPath?: string;
  legacyPush?: { ok: boolean; error?: string; skipped?: boolean };
  schemaPush?: { applied: string[]; skipped?: boolean; error?: string };
  error?: string;
}

export interface CutoverBatchResult {
  dryRun: boolean;
  results: CutoverRunResult[];
  attempted: number;
  succeeded: number;
  blocked: number;
  skipped: number;
}
