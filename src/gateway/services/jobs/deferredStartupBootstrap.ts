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

  const { getAppService } = await import("../AppService.js");
  const appService = getAppService();
  await appService.installPendingDefaultJobs();

  const homeOk = await appService.homeLinkedSourcesInvariantsOk();
  let repairRan = false;
  if (!epochOk || !homeOk) {
    await appService.repairHomeAndWorkspaceOnStartup();
    repairRan = true;
  }

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
