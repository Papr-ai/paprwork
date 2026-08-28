/**
 * Central workspace readiness gate.
 *
 * While a barrier is raised, background work (cloud sync, job reconcile, scheduler
 * ticks, deferred pushes) must await {@link waitForWorkspaceReady} before touching
 * path-bound state. HTTP handlers can use {@link workspaceReadinessMiddleware}.
 *
 * Lifecycle (owned by workspaceSwitchService):
 *   beginWorkspaceReadinessBarrier() → switch + reinit → releaseWorkspaceReadinessBarrier()
 */

import type { Request, Response, NextFunction } from "express";
import { getWorkspaceSwitchStatus } from "./workspaceSwitchService.js";

let barrierGeneration = 0;
let pendingBarrier: Promise<void> | null = null;
let releaseBarrier: (() => void) | null = null;

/** Raise the gate — callers must await {@link waitForWorkspaceReady} before side effects. */
export function beginWorkspaceReadinessBarrier(reason: string): number {
  barrierGeneration += 1;
  const gen = barrierGeneration;
  if (pendingBarrier === null) {
    pendingBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
  }
  console.log(`[WorkspaceReadiness] Barrier raised: ${reason} (gen ${gen})`);
  return gen;
}

/** Drop the gate once path-bound services match the active workspace pointer. */
export function releaseWorkspaceReadinessBarrier(
  reason: string,
  expectedGen?: number,
): void {
  if (expectedGen !== undefined && expectedGen !== barrierGeneration) {
    console.log(
      `[WorkspaceReadiness] Ignoring stale release for gen ${expectedGen} (current ${barrierGeneration})`,
    );
    return;
  }
  if (releaseBarrier) {
    releaseBarrier();
    releaseBarrier = null;
    pendingBarrier = null;
    console.log(`[WorkspaceReadiness] Barrier released: ${reason}`);
  }
}

/** True when core workspace reinit finished (apps/jobs/storage aligned with pointer). */
export function isWorkspaceCoreReady(): boolean {
  if (pendingBarrier !== null) {
    return false;
  }
  return !getWorkspaceSwitchStatus().active;
}

/**
 * Block until the active org/namespace is safe for path-bound reads and writes.
 * Resolves immediately when no switch is in progress.
 */
export async function waitForWorkspaceReady(): Promise<void> {
  if (pendingBarrier !== null) {
    await pendingBarrier;
  }
}

/** Run side-effect work only after the workspace gate opens. */
export async function runWhenWorkspaceReady<T>(
  context: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  await waitForWorkspaceReady();
  if (!isWorkspaceCoreReady()) {
    console.log(`[WorkspaceReadiness] Skipped ${context} — workspace not core-ready`);
    return undefined;
  }
  return fn();
}

const READINESS_EXEMPT_PREFIXES = [
  "/health",
  "/api/workspace/",
] as const;

/** Returns 503 while the workspace gate is raised (except health + switch endpoints). */
export function workspaceReadinessMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const path = req.path;
  if (READINESS_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    next();
    return;
  }
  if (isWorkspaceCoreReady()) {
    next();
    return;
  }
  res.status(503).json({
    error: "Workspace switch in progress",
    retryAfterMs: 1000,
    phase: getWorkspaceSwitchStatus().phase,
  });
}

/** @internal test hook */
export function resetWorkspaceReadinessForTests(): void {
  releaseBarrier?.();
  releaseBarrier = null;
  pendingBarrier = null;
  barrierGeneration = 0;
}
