/**
 * SyncCoordinator types (Phase 5 — SYNC_CONTRACT §7, SYNC_ARCHITECTURE_V2 §2.5).
 */

import type { FlushAppNowResult } from "./flushAppNow.js";

export type SyncCoordinatorLayer = "git" | "turso" | "publish";

export interface SyncCoordinatorActiveFlush {
  appId: string;
  layer: SyncCoordinatorLayer;
  startedAt: number;
  label?: string;
  detail?: string;
}

export interface SyncCoordinatorStatus {
  /** First running flush (kept for single-flush callers). */
  activeFlush: SyncCoordinatorActiveFlush | null;
  /** Every flush running now — publishes run in parallel. */
  activeFlushes: SyncCoordinatorActiveFlush[];
  gitDirtyAppIds: string[];
  dbDirtySyncKeys: string[];
  inFlightAppIds: string[];
  queuedFlushAppIds: string[];
  flushErrors: Record<
    string,
    {
      message: string;
      at: string;
      retryPending: boolean;
      kind?: "conflict" | "error";
      conflictPaths?: string[];
    }
  >;
}

export interface FlushNowOptions {
  /** auto = debounced watcher path; manual = Upload now / API */
  trigger?: "auto" | "manual" | "contribute";
}

export type FlushTrigger = NonNullable<FlushNowOptions["trigger"]>;

export type CoordinatorFlushResult = FlushAppNowResult;

export interface RunPostSyncHooksOptions {
  /** Skip post-git Turso reschedule when ordered flush already pushed DBs. */
  skipTursoReschedule?: boolean;
}
