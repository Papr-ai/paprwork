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

async function runDeferredHomeWorkspaceRepair(): Promise<void> {
  const startedAt = performance.now();

  const { getAppService } = await import("../AppService.js");
  const appService = getAppService();
  await appService.installPendingDefaultJobs();
  await appService.repairHomeAndWorkspaceOnStartup();

  const { projectGoalsAndTasks, isHomeGoalsProjectionReady } = await import(
    "../goalsTasksProjection.js"
  );
  if (await isHomeGoalsProjectionReady()) {
    await projectGoalsAndTasks("boot");
  } else {
    console.log(
      "[GoalsTasksProjection] boot skipped: Home briefs goals schema not ready",
    );
  }

  const { getWorkspaceService } = await import("../WorkspaceService.js");
  await getWorkspaceService().ensureSleepJob();
  await getWorkspaceService().ensureWikiWriterJob();

  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(
    `[Gateway] Background: home repair + built-in jobs complete (${elapsedMs}ms)`,
  );
}
