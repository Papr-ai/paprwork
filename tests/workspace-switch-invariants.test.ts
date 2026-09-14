/**
 * Regression guards for org/namespace workspace switching.
 *
 * These are static invariant tests — if a change breaks workspace isolation,
 * CI fails before we ship another cross-org corruption or startup deadlock.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), "utf-8");
}

/**
 * Slice the source between two anchors, failing loudly if either has moved.
 *
 * Every invariant here scopes its assertions to one function by string anchor,
 * and a bare `indexOf` degrades silently when the source is merely reformatted.
 * A missing *start* gives `slice(-1, n)` — usually `""`, so the assertion fails
 * for a reason that has nothing to do with the invariant. A missing *end* gives
 * `slice(n, -1)`, widening the slice to the whole rest of the file, so a scoped
 * `toContain` can pass on text from an unrelated function and a `not.toContain`
 * can fail on it. That second case is the dangerous one: the guard reports
 * success while checking nothing.
 *
 * So resolve both anchors up front and name the one that moved. An anchor that
 * no longer matches means the code was renamed or rewrapped — update the
 * anchor, never delete the invariant.
 */
function sliceBetween(
  content: string,
  file: string,
  startAnchor: string,
  endAnchor: string,
): string {
  const start = content.indexOf(startAnchor);
  const end = content.indexOf(endAnchor);

  if (start === -1) {
    throw new Error(
      `[${file}] start anchor not found: ${JSON.stringify(startAnchor)}`,
    );
  }
  if (end === -1) {
    throw new Error(
      `[${file}] end anchor not found: ${JSON.stringify(endAnchor)} — ` +
        `without it the slice would widen to the rest of the file and these ` +
        `assertions would stop being scoped to one function`,
    );
  }
  if (end <= start) {
    throw new Error(
      `[${file}] anchors out of order: ${JSON.stringify(endAnchor)} appears ` +
        `before ${JSON.stringify(startAnchor)}`,
    );
  }

  return content.slice(start, end);
}

/** Index of `needle`, asserting it exists so ordering checks cannot read -1. */
function requireIndex(haystack: string, file: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    throw new Error(`[${file}] expected to find ${JSON.stringify(needle)}`);
  }
  return idx;
}

describe("workspace switch — JobsService invariants", () => {
  const JOBS = "src/gateway/services/JobsService.ts";

  it("deleteJob passes known job to preserve (no re-entrant initialize during init)", () => {
    const deleteFn = sliceBetween(
      read(JOBS),
      JOBS,
      "async deleteJob(",
      "async stopJob(",
    );

    expect(deleteFn).toContain(
      "preserveJobLinkedDatabasesBeforeDelete(jobId, job)",
    );
    expect(deleteFn).not.toContain(
      "preserveJobLinkedDatabasesBeforeDelete(jobId);",
    );
  });

  it("deleteJob cloud cleanup is fire-and-forget (never blocks caller on pushNow)", () => {
    const deleteFn = sliceBetween(
      read(JOBS),
      JOBS,
      "async deleteJob(",
      "async stopJob(",
    );

    expect(deleteFn).toContain("voidDeleteJobCloudArtifacts");
    expect(deleteFn).not.toMatch(/await deleteJobCloudArtifacts\(/);
  });

  it("startup reconcile uses deferCloudCleanup (no blocking cloud push during initialize)", () => {
    const reconcileFn = sliceBetween(
      read(JOBS),
      JOBS,
      "reconcileDuplicateHomeDailyBriefJobsIfNeeded",
      "private async backfillJobAppIds",
    );

    expect(reconcileFn).toContain("deferCloudCleanup: true");
  });

  it("reconcile duplicate Home Daily Brief runs after installDefaultJobs", () => {
    const initFn = sliceBetween(
      read(JOBS),
      JOBS,
      "private async runInitialize",
      "private voidDeleteJobCloudArtifacts",
    );

    // Anchored on the calls themselves. These were once wrapped in a `step()`
    // helper; the wrapper went away and the invariant silently stopped being
    // checked, because `indexOf` on the old label returned -1 and -1 > -1 is
    // false — a broken guard that read as a broken invariant.
    const installIdx = requireIndex(
      initFn,
      JOBS,
      "await this.installDefaultJobs()",
    );
    const reconcileIdx = requireIndex(
      initFn,
      JOBS,
      "await this.reconcileDuplicateHomeDailyBriefJobsIfNeeded()",
    );
    expect(reconcileIdx).toBeGreaterThan(installIdx);
  });

  it("migrateAndHydrate skips tombstoned and migrated legacy Daily Brief dirs", () => {
    const hydrateFn = sliceBetween(
      read(JOBS),
      JOBS,
      "private async migrateAndHydrateJobRuntimeFiles",
      "private async hydrateJobRuntimeFromCloud",
    );

    expect(hydrateFn).toContain("readJobTombstones");
    expect(hydrateFn).toContain("shouldSkipDailyBriefJobDirRecovery");
  });

  it("reconcileRegistryAfterSync respects workspace write guard", () => {
    const reconcileFn = sliceBetween(
      read(JOBS),
      JOBS,
      "async reconcileRegistryAfterSync(",
      "async migrateAndHydrateJobRuntimeFiles(",
    );

    expect(reconcileFn).toContain(
      'isWriteContextValid("jobs registry reconcile")',
    );
    expect(reconcileFn).toContain("this.boundPaprDir ?? getPaprRoot()");
  });
});

describe("workspace switch — post-sync / cloud invariants", () => {
  it("jobs registry reconcile waits on central readiness gate", () => {
    const content = read("src/gateway/services/jobs/jobsRegistryReconcile.ts");

    expect(content).toContain("waitForWorkspaceReady");
    expect(content).not.toContain("getWorkspaceSwitchHealthStatus");
  });

  it("workspace switch raises and releases central readiness barrier", () => {
    const file = "src/gateway/services/workspaceSwitchService.ts";
    const content = read(file);
    const switchFn = sliceBetween(
      content,
      file,
      "export async function switchActiveWorkspace",
      "/** Cloud sync, Turso, and vault",
    );
    const bgFn = sliceBetween(
      content,
      file,
      "async function finishWorkspaceSwitchInBackground",
      "export async function switchActiveWorkspace",
    );

    expect(switchFn).toContain("beginWorkspaceReadinessBarrier");
    expect(switchFn).toContain("readinessGeneration");
    expect(bgFn).toContain("releaseWorkspaceReadinessBarrier");
  });

  it("deferred cloud sync startup waits on central readiness gate", () => {
    const file = "src/gateway/index.ts";
    const block = sliceBetween(
      read(file),
      file,
      "tryDeferredCloudSyncStartup",
      "setTimeout(tryDeferredCloudSyncStartup",
    );

    expect(block).toContain("waitForWorkspaceReady");
  });

  it("gateway applies workspace readiness middleware", () => {
    const content = read("src/gateway/index.ts");
    expect(content).toContain("workspaceReadinessMiddleware");
  });

  it("JobsScheduler tick waits on central readiness gate", () => {
    const file = "src/gateway/services/JobsScheduler.ts";
    // `tick()` is now the last method on the class, so anchor the end on the
    // module-level getter that follows it. The old `scheduleNextWake` anchor
    // was gone, which made this slice run to end-of-file — so the assertion
    // was passing on text from elsewhere in the module rather than from
    // `tick()`. The call is genuinely there; the guard just wasn't looking.
    const tickFn = sliceBetween(
      read(file),
      file,
      "private async tick(",
      "export function getJobsScheduler(",
    );
    expect(tickFn).toContain("waitForWorkspaceReady");
  });

  it("cloud sync queue item waits on central readiness gate", () => {
    const content = read(
      "src/gateway/services/cloudSync/cloudSyncQueueProcessor.ts",
    );
    expect(content).toContain("waitForWorkspaceReady");
  });
});

describe("workspace switch — registry write guard invariants", () => {
  it("AppService.saveApps respects workspace write guard", () => {
    const file = "src/gateway/services/AppService.ts";
    const content = read(file);
    const saveFn = sliceBetween(
      content,
      file,
      "private async saveApps(",
      "private extractFaviconFromHTML",
    );

    expect(saveFn).toContain('isWriteContextValid("apps.json save")');
    expect(content).toContain("bindWorkspaceWriteContext");
  });

  it("DatabaseRegistry.save respects workspace write guard", () => {
    const file = "src/gateway/services/DatabaseRegistryService.ts";
    const content = read(file);
    // Anchored on `save(` alone: the signature grew a second parameter and
    // wrapped across lines, so the old `save(state:` anchor stopped matching
    // and this guard went dark while the guard it checks was intact.
    const saveFn = sliceBetween(
      content,
      file,
      "private async save(",
      "private getState():",
    );

    expect(saveFn).toContain('isWriteContextValid("databases.json save")');
    expect(content).toContain("bindWorkspaceWriteContext");
  });

  it("JobsService.saveJobs respects workspace write guard", () => {
    const file = "src/gateway/services/JobsService.ts";
    const saveFn = sliceBetween(
      read(file),
      file,
      "private async saveJobs(",
      "private async persistJobRecord",
    );

    expect(saveFn).toContain('isWriteContextValid("jobs.json save")');
  });
});

describe("workspace switch — Electron startup invariants", () => {
  it("reconciles pointer and API key before profile sync and gateway spawn", () => {
    const file = "src/electron/index.cjs";
    const content = read(file);

    const reconcileIdx = requireIndex(
      content,
      file,
      "ensureActiveWorkspaceReconciled(settingsStorage)",
    );
    const apiKeyIdx = requireIndex(
      content,
      file,
      "ensureActiveNamespaceApiKey(customKeysStorage, settingsStorage)",
    );
    const profileSyncIdx = requireIndex(
      content,
      file,
      "syncProfileToGatewaySettings(",
    );
    const supervisorIdx = requireIndex(
      content,
      file,
      "await supervisor.start()",
    );

    expect(apiKeyIdx).toBeGreaterThan(reconcileIdx);
    expect(profileSyncIdx).toBeGreaterThan(apiKeyIdx);
    expect(supervisorIdx).toBeGreaterThan(profileSyncIdx);
  });

  it("validates cached API key matches active namespace before reuse", () => {
    const file = "src/electron/ipc/paprLogin.ts";
    const fn = sliceBetween(
      read(file),
      file,
      "async function ensureActiveNamespaceApiKeyInternal",
      "export interface EnsureActiveWorkspaceReconciledResult",
    );

    expect(fn).toContain("paprApiKeyMatchesNamespaceBound");
    expect(fn).toContain("namespace mismatch");
  });
});

describe("workspace switch — resource lifecycle invariants", () => {
  it("pauseWorkspaceSwitchWriters drains Turso replica connections", () => {
    const file = "src/gateway/services/workspaceSwitchService.ts";
    const pauseFn = sliceBetween(
      read(file),
      file,
      "async function pauseWorkspaceSwitchWriters",
      "const WORKSPACE_SWITCH_JOB_STOP_REASON",
    );

    expect(pauseFn).toContain("drainTursoReplicaConnections");
    expect(pauseFn).toContain("cancelAllScheduledTursoReplicaPushes");
  });

  it("gateway shutdown drains Turso replicas and platform sessions", () => {
    const file = "src/gateway/index.ts";
    const shutdownFn = sliceBetween(
      read(file),
      file,
      "const shutdown = async () =>",
      'process.on("SIGINT", shutdown)',
    );

    expect(shutdownFn).toContain("drainTursoReplicaConnections");
    expect(shutdownFn).toContain("closeRealChromePlatformSession");
    expect(shutdownFn).toContain("getPlatformSessionService().shutdown()");
  });

  it("bash exec uses stdin-ignored shell helper (prevents Gateway EBADF)", () => {
    const content = read("src/core/tools/bash.ts");
    expect(content).toContain("execShellCommand");
    expect(content).toContain("SPAWN_STDIO_IGNORE_IN");
    expect(content).not.toMatch(/=\s*exec\s*\(/);
  });
});

describe("workspace switch — database promotion invariants", () => {
  it("preserveJobLinkedDatabasesBeforeDelete skips initialize when job is provided", () => {
    const file = "src/gateway/services/databasePromotion.ts";
    const fn = sliceBetween(
      read(file),
      file,
      "export async function preserveJobLinkedDatabasesBeforeDelete",
      "const jobDir = path.join(getPaprJobsRoot(), jobId)",
    );

    expect(fn).toContain("knownJob?: JobRecord | null");
    expect(fn).toContain("getJobsService().getJob(jobId)");
    expect(fn).not.toContain("await jobsService.initialize()");
  });
});
