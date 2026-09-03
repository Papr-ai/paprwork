/**
 * Plan A — Turso Sync replica types (Turso primary, local file is replica cache).
 */

import type { MigrationPushConflict } from "./tursoReplicaMigrationConflict.js";

/** Per-database sync path in databases.json */
export type DatabaseSyncMode = "legacy" | "replica";

export interface TursoReplicaDatabaseStats {
  cdcOperations: number;
}

export interface TursoReplicaConnectOptions {
  localPath: string;
  tursoUrl: string;
  authToken: string;
  /** When false, do not bootstrap from remote if local file exists. */
  bootstrapIfEmpty?: boolean;
  clientName?: string;
  /** Online primary writes — experimental Turso Sync remote write path. */
  remoteWritesExperimental?: boolean;
}

export interface TursoReplicaPushResult {
  ok: true;
}

export interface TursoReplicaPushError {
  ok: false;
  error: string;
  conflictCode?: MigrationPushConflict["code"];
  localOnlyMigrationIds?: string[];
  cloudAheadMigrationIds?: string[];
}

export type TursoReplicaPushResponse = TursoReplicaPushResult | TursoReplicaPushError;

export interface TursoReplicaSyncStatus {
  online: boolean;
  syncMode: DatabaseSyncMode;
  pendingPush: boolean;
  pendingOps: number;
  lastPushError: string | null;
  migrationConflict: boolean;
  cutoverBlocked: boolean;
  cutoverBlockReason: string | null;
  /** True when sync WAL is empty but -info claims progress — pull/push will wedge. */
  sidecarWedge: boolean;
  stats: TursoReplicaDatabaseStats | null;
}

export interface TursoReplicaWriteResult {
  changes: number;
  lastInsertRowid: number;
  pendingPush: boolean;
  backend: "turso-replica";
}

/** When pushAfterWrite is false, apply on replica only — no pull/push to Turso primary. */
export interface TursoReplicaWriteOptions {
  pushAfterWrite?: boolean;
}
