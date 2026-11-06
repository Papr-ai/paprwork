/**
 * Job maintenance, bundled default jobs, home repair, and built-in agent jobs.
 * Runs after gatewayReady so the UI can connect while heavy work continues.
 */

import { getJobsService } from "../JobsService.js";

export async function runDeferredJobsWorkspaceBootstrap(): Promise<void> {
  const startedAt = performance.now();
  console.log("[Gateway] Background: jobs maintenance starting…");

  await getJobsService().waitForStartupMaintenance();

  const maintenanceMs = Math.round(performance.now() - startedAt);
  const { recordDeferredStartupStep } = await import(
    "../gatewayStartupTiming.js"
  );
  recordDeferredStartupStep(
    "deferred",
    "JobsService.startupMaintenance",
    maintenanceMs,
  );
  console.log(
    `[Gateway] Background: jobs maintenance complete (${maintenanceMs}ms); home repair deferred`,
  );

  void runDeferredHomeWorkspaceRepair().catch((err) => {
    console.warn(
      "[Gateway] Deferred home/workspace repair failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

/** After fresh replica migrations — brief pause for sync handle (not env-configurable). */
const REPLICA_SCHEMA_SETTLE_MS = 2_000;

async function runDeferredHomeWorkspaceRepair(): Promise<void> {
  const startedAt = performance.now();

  const { DEFERRED_HOME_WORKSPACE_BOOT_EPOCH } = await import(
    "../deferredHomeWorkspaceBootEpoch.js"
  );
  const { loadGatewayDeferredBootState, saveGatewayDeferredBootState } =
    await import("../gatewayDeferredBootState.js");

  const prior = await loadGatewayDeferredBootState();
  const epochOk = (prior?.appliedEpoch ?? 0) >= DEFERRED_HOME_WORKSPACE_BOOT_EPOCH;

  const {
    computeGoalsWorkspaceFingerprint,
    probeHomeGoalsTableExists,
    ensureHomeGoalsTasksSchema,
    projectGoalsAndTasks,
  } = await import("../goalsTasksProjection.js");
  const workspaceFp = await computeGoalsWorkspaceFingerprint();
  const workspaceFpOk = prior?.goalsWorkspaceFingerprint === workspaceFp;

  // The Home dashboard app is retired (Focus is native). Take it off this device; keep its data.
  const { retireHomeApp } = await import("../retireHomeApp.js");
  const repairRan = await retireHomeApp().catch((err) => {
    console.warn("[Gateway] Retiring the Home app failed:", err instanceof Error ? err.message : err);
    return false;
  });

  let goalsReady = await probeHomeGoalsTableExists();
  let schemaApplied: string[] = [];
  if (!goalsReady) {
    schemaApplied = await ensureHomeGoalsTasksSchema();
    goalsReady = await probeHomeGoalsTableExists();
  }

  if (schemaApplied.length > 0 && REPLICA_SCHEMA_SETTLE_MS > 0) {
    console.log(
      `[GoalsTasksProjection] migrations applied (${schemaApplied.join(", ")}); settling ${REPLICA_SCHEMA_SETTLE_MS}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, REPLICA_SCHEMA_SETTLE_MS));
  }

  const skipProjection =
    epochOk && workspaceFpOk && !repairRan && goalsReady;
  let projectionOutcome: "ran" | "skipped" | "not-ready" = "not-ready";
  if (skipProjection) {
    projectionOutcome = "skipped";
    console.log(
      "[GoalsTasksProjection] boot skipped (epoch current, workspace unchanged, home links ok)",
    );
    // Mongo is the shared copy: pull what changed on other devices even when nothing changed here.
    void import("../focusCloud/focusCloudSync.js").then((m) => m.scheduleFocusCloudSync("boot", 5000)).catch(() => undefined);
  } else if (goalsReady) {
    await projectGoalsAndTasks("boot");
    projectionOutcome = "ran";
  } else {
    console.log(
      "[GoalsTasksProjection] boot skipped: Home briefs goals schema not ready",
    );
  }

  const { getWorkspaceService } = await import("../WorkspaceService.js");
  await getWorkspaceService().ensureSleepJob();
  await getWorkspaceService().ensureWikiWriterJob();
  // Daily Brief + trackers are Papr Work's own jobs now (re-links ones Home used to own).
  const { ensureFocusSystemJobs } = await import("../focusSystemJobs.js");
  await ensureFocusSystemJobs();

  await saveGatewayDeferredBootState({
    appliedEpoch: DEFERRED_HOME_WORKSPACE_BOOT_EPOCH,
    goalsWorkspaceFingerprint: workspaceFp,
    completedAt: new Date().toISOString(),
  });

  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(
    `[Gateway] Background: deferred workspace boot complete (${elapsedMs}ms; ` +
      `repair=${repairRan ? "ran" : "skipped"} projection=${projectionOutcome})`,
  );
}
