/**
 * Sync V3 Phase 3 — workspace log (_papr_oplog) types.
 * @see docs/SYNC_ARCHITECTURE_V3.md §2
 */

import type { JobMigrationSchemaOp } from "./jobMigrations.js";

export type WorkspaceLogKind = "row" | "schema" | "snapshot";

export interface WorkspaceLogRowPayload {
  appId: string;
  sql: string;
  params?: unknown[];
}

export interface WorkspaceLogSchemaPayload {
  appId: string;
  dbSlug?: string;
  /** Normalized migration id (no .sql suffix). Omitted for inline runtime CREATE. */
  migrationId?: string;
  /** SHA-256 hex of migration file bytes or canonical ops payload. */
  contentHash?: string;
  /** Runtime mini-app DDL only — CREATE TABLE IF NOT EXISTS. */
  sql?: string;
  ops?: JobMigrationSchemaOp[];
  statements?: string[];
}

export interface WorkspaceLogSnapshotPayload {
  snapshotHash: string;
  tableCount: number;
  genesis?: boolean;
}

export type WorkspaceLogPayload =
  | WorkspaceLogRowPayload
  | WorkspaceLogSchemaPayload
  | WorkspaceLogSnapshotPayload;

export interface WorkspaceLogEntry {
  seq: number;
  hlc: string;
  kind: WorkspaceLogKind;
  dbSourceId: string | null;
  payload: WorkspaceLogPayload;
}

export interface WorkspaceLogAppendRequest {
  replicaId: string;
  kind: WorkspaceLogKind;
  dbSourceId?: string;
  payload: WorkspaceLogPayload;
}

/** Pre-validated scope from cloud app host — enables memory fast path on append. */
export interface WorkspaceLogHostScope {
  orgId: string;
  namespaceId: string;
  ownerUserId: string;
  appId: string;
}

export interface WorkspaceLogAppendResponse {
  replicaId: string;
  seq: number;
  hlc: string;
  kind: WorkspaceLogKind;
  dbSourceId: string | null;
  latencyMs: number;
  /** Row materialization result (kind=row only). */
  changes?: number;
  lastInsertRowid?: number;
}

export interface WorkspaceLogBatchEntry {
  kind: WorkspaceLogKind;
  dbSourceId?: string;
  payload: WorkspaceLogPayload;
}

export interface WorkspaceLogAppendBatchRequest {
  replicaId: string;
  entries: WorkspaceLogBatchEntry[];
}

export interface WorkspaceLogAppendBatchResponse {
  replicaId: string;
  firstSeq: number;
  lastSeq: number;
  count: number;
  hlc: string;
  latencyMs: number;
  /** Schema entries materialized onto Turso before HTTP 200 (append-batch). */
  schemaAppliedCount?: number;
}

export interface WorkspaceLogSinceResponse {
  replicaId: string;
  cursor: number;
  nextCursor: number;
  entries: WorkspaceLogEntry[];
  hasMore: boolean;
}

export interface WorkspaceLogGenesisRequest {
  replicaId: string;
  dbSourceId?: string;
  snapshotHash: string;
  tableCount: number;
}
