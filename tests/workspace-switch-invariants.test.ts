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

describe("workspace switch — JobsService invariants", () => {
  it("deleteJob passes known job to preserve (no re-entrant initialize during init)", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const deleteFn = content.slice(
      content.indexOf("async deleteJob("),
      content.indexOf("async stopJob("),
    );

    expect(deleteFn).toContain(
      "preserveJobLinkedDatabasesBeforeDelete(jobId, job)",
    );
    expect(deleteFn).not.toContain(
      "preserveJobLinkedDatabasesBeforeDelete(jobId);",
    );
  });

  it("deleteJob cloud cleanup is fire-and-forget (never blocks caller on pushNow)", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const deleteFn = content.slice(
      content.indexOf("async deleteJob("),
      content.indexOf("async stopJob("),
    );

    expect(deleteFn).toContain("voidDeleteJobCloudArtifacts");
    expect(deleteFn).not.toMatch(/await deleteJobCloudArtifacts\(/);
  });

  it("startup reconcile uses deferCloudCleanup (no blocking cloud push during initialize)", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const reconcileFn = content.slice(
      content.indexOf("reconcileDuplicateHomeDailyBriefJobsIfNeeded"),
      content.indexOf("private async backfillJobAppIds"),
    );

    expect(reconcileFn).toContain("deferCloudCleanup: true");
  });

  it("reconcile duplicate Home Daily Brief runs after installDefaultJobs", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const initFn = content.slice(
      content.indexOf("private async runInitialize"),
      content.indexOf("private voidDeleteJobCloudArtifacts"),
    );

    const installIdx = initFn.indexOf('step("install default jobs")');
    const reconcileIdx = initFn.indexOf('step("reconcile duplicate Home Daily Brief")');
    expect(installIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(installIdx);
  });

  it("migrateAndHydrate skips tombstoned and migrated legacy Daily Brief dirs", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const hydrateFn = content.slice(
      content.indexOf("private async migrateAndHydrateJobRuntimeFiles"),
      content.indexOf("private async hydrateJobRuntimeFromCloud"),
    );

    expect(hydrateFn).toContain("readJobTombstones");
    expect(hydrateFn).toContain("shouldSkipDailyBriefJobDirRecovery");
  });

  it("reconcileRegistryAfterSync respects workspace write guard", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const reconcileFn = content.slice(
      content.indexOf("async reconcileRegistryAfterSync("),
      content.indexOf("async migrateAndHydrateJobRuntimeFiles("),
    );

    expect(reconcileFn).toContain('isWriteContextValid("jobs registry reconcile")');
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
    const content = read("src/gateway/services/workspaceSwitchService.ts");
    const switchFn = content.slice(
      content.indexOf("export async function switchActiveWorkspace"),
      content.indexOf("/** Cloud sync, Turso, and vault"),
    );
    const bgFn = content.slice(
      content.indexOf("async function finishWorkspaceSwitchInBackground"),
      content.indexOf("export async function switchActiveWorkspace"),
    );

    expect(switchFn).toContain("beginWorkspaceReadinessBarrier");
    expect(switchFn).toContain("readinessGeneration");
    expect(bgFn).toContain("releaseWorkspaceReadinessBarrier");
  });

  it("deferred cloud sync startup waits on central readiness gate", () => {
    const content = read("src/gateway/index.ts");
    const block = content.slice(
      content.indexOf("tryDeferredCloudSyncStartup"),
      content.indexOf("setTimeout(tryDeferredCloudSyncStartup"),
    );

    expect(block).toContain("waitForWorkspaceReady");
  });

  it("gateway applies workspace readiness middleware", () => {
    const content = read("src/gateway/index.ts");
    expect(content).toContain("workspaceReadinessMiddleware");
  });

  it("JobsScheduler tick waits on central readiness gate", () => {
    const content = read("src/gateway/services/JobsScheduler.ts");
    const tickFn = content.slice(
      content.indexOf("private async tick("),
      content.indexOf("private scheduleNextWake("),
    );
    expect(tickFn).toContain("waitForWorkspaceReady");
  });

  it("cloud sync queue item waits on central readiness gate", () => {
    const content = read("src/gateway/services/cloudSync/cloudSyncQueueProcessor.ts");
    expect(content).toContain("waitForWorkspaceReady");
  });
});

describe("workspace switch — registry write guard invariants", () => {
  it("AppService.saveApps respects workspace write guard", () => {
    const content = read("src/gateway/services/AppService.ts");
    const saveFn = content.slice(
      content.indexOf("private async saveApps("),
      content.indexOf("private extractFaviconFromHTML"),
    );

    expect(saveFn).toContain('isWriteContextValid("apps.json save")');
    expect(content).toContain("bindWorkspaceWriteContext");
  });

  it("DatabaseRegistry.save respects workspace write guard", () => {
    const content = read("src/gateway/services/DatabaseRegistryService.ts");
    const saveFn = content.slice(
      content.indexOf("private async save(state:"),
      content.indexOf("private getState():"),
    );

    expect(saveFn).toContain('isWriteContextValid("databases.json save")');
    expect(content).toContain("bindWorkspaceWriteContext");
  });

  it("JobsService.saveJobs respects workspace write guard", () => {
    const content = read("src/gateway/services/JobsService.ts");
    const saveFn = content.slice(
      content.indexOf("private async saveJobs("),
      content.indexOf("private async persistJobRecord"),
    );

    expect(saveFn).toContain('isWriteContextValid("jobs.json save")');
  });
});

describe("workspace switch — Electron startup invariants", () => {
  it("reconciles pointer and API key before profile sync and gateway spawn", () => {
    const content = read("src/electron/index.cjs");

    const reconcileIdx = content.indexOf("ensureActiveWorkspaceReconciled(settingsStorage)");
    const apiKeyIdx = content.indexOf(
      "ensureActiveNamespaceApiKey(customKeysStorage, settingsStorage)",
    );
    const profileSyncIdx = content.indexOf("syncProfileToGatewaySettings(");
    const supervisorIdx = content.indexOf("await supervisor.start()");

    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(apiKeyIdx).toBeGreaterThan(reconcileIdx);
    expect(profileSyncIdx).toBeGreaterThan(apiKeyIdx);
    expect(supervisorIdx).toBeGreaterThan(profileSyncIdx);
  });

  it("validates cached API key matches active namespace before reuse", () => {
    const content = read("src/electron/ipc/paprLogin.ts");
    const fn = content.slice(
      content.indexOf("async function ensureActiveNamespaceApiKeyInternal"),
      content.indexOf("export interface EnsureActiveWorkspaceReconciledResult"),
    );

    expect(fn).toContain("paprApiKeyMatchesNamespaceBound");
    expect(fn).toContain("namespace mismatch");
  });
});

describe("workspace switch — resource lifecycle invariants", () => {
  it("pauseWorkspaceSwitchWriters drains Turso replica connections", () => {
    const content = read("src/gateway/services/workspaceSwitchService.ts");
    const pauseFn = content.slice(
      content.indexOf("async function pauseWorkspaceSwitchWriters"),
      content.indexOf("const WORKSPACE_SWITCH_JOB_STOP_REASON"),
    );

    expect(pauseFn).toContain("drainTursoReplicaConnections");
    expect(pauseFn).toContain("cancelAllScheduledTursoReplicaPushes");
  });

  it("gateway shutdown drains Turso replicas and platform sessions", () => {
    const content = read("src/gateway/index.ts");
    const shutdownFn = content.slice(
      content.indexOf("const shutdown = async () =>"),
      content.indexOf("process.on(\"SIGINT\", shutdown)"),
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
    const content = read("src/gateway/services/databasePromotion.ts");
    const fn = content.slice(
      content.indexOf("export async function preserveJobLinkedDatabasesBeforeDelete"),
      content.indexOf("const jobDir = path.join(getPaprJobsRoot(), jobId)"),
    );

    expect(fn).toContain("knownJob?: JobRecord | null");
    expect(fn).toContain("getJobsService().getJob(jobId)");
    expect(fn).not.toContain("await jobsService.initialize()");
  });
});
