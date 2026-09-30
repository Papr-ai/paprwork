/**
 * Prevents cloud/git/Turso/publish/jobs writes after a workspace switch starts.
 * Long-running ops capture {@link getWorkspaceWriteGeneration} at start and
 * must re-check before persisting — stale generation means abort.
 */

import path from "path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { isTursoStateDbPathInWorkspace } from "./tursoSyncState.js";

let writeGeneration = 0;

export class WorkspaceWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWriteBlockedError";
  }
}

/** Increment at workspace switch start — invalidates in-flight writers. */
export function bumpWorkspaceWriteGeneration(reason: string): number {
  writeGeneration += 1;
  console.log(
    `[WorkspaceWriteGuard] Write generation ${writeGeneration} (${reason})`,
  );
  return writeGeneration;
}

export function getWorkspaceWriteGeneration(): number {
  return writeGeneration;
}

/** @internal test hook */
export function resetWorkspaceWriteGenerationForTests(): void {
  writeGeneration = 0;
}

export function isWorkspaceWriteStale(capturedGeneration: number): boolean {
  return capturedGeneration !== writeGeneration;
}

export function isPaprDirInActiveWorkspace(paprDir: string): boolean {
  const active = path.resolve(getPaprRoot());
  const target = path.resolve(paprDir);
  return target === active || target.startsWith(`${active}${path.sep}`);
}

export function canPerformWorkspaceWrite(
  capturedGeneration: number,
  paprDir: string,
  context: string,
): boolean {
  if (isWorkspaceWriteStale(capturedGeneration)) {
    console.warn(
      `[WorkspaceWriteGuard] Blocked ${context}: workspace switch in progress (gen ${capturedGeneration} → ${writeGeneration})`,
    );
    return false;
  }
  if (!isPaprDirInActiveWorkspace(paprDir)) {
    console.warn(
      `[WorkspaceWriteGuard] Blocked ${context}: path outside active workspace (${paprDir})`,
    );
    return false;
  }
  return true;
}

export function canPerformWorkspaceDbWrite(
  capturedGeneration: number,
  dbPath: string,
  context: string,
): boolean {
  if (isWorkspaceWriteStale(capturedGeneration)) {
    console.warn(
      `[WorkspaceWriteGuard] Blocked ${context}: workspace switch in progress (gen ${capturedGeneration} → ${writeGeneration})`,
    );
    return false;
  }
  if (!isTursoStateDbPathInWorkspace(dbPath)) {
    console.warn(
      `[WorkspaceWriteGuard] Blocked ${context}: DB outside active workspace (${dbPath})`,
    );
    return false;
  }
  return true;
}

export function assertWorkspaceWriteAllowed(
  capturedGeneration: number,
  paprDir: string,
  context: string,
): void {
  if (!canPerformWorkspaceWrite(capturedGeneration, paprDir, context)) {
    throw new WorkspaceWriteBlockedError(`Blocked ${context}`);
  }
}
