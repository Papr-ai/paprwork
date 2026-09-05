/**
 * Job maintenance, bundled default jobs, home repair, and built-in agent jobs.
 * Runs after gatewayReady so the UI can connect while heavy work continues.
 */

import { getJobsService } from "../JobsService.js";

export async function runDeferredJobsWorkspaceBootstrap(): Promise<void> {
  const startedAt = performance.now();
  console.log("[Gateway] Background: jobs maintenance + home repair starting…");

  await getJobsService().waitForStartupMaintenance();

  const { getAppService } = await import("../AppService.js");
  const appService = getAppService();
  await appService.installPendingDefaultJobs();
  await appService.repairHomeAndWorkspaceOnStartup();

  const { projectGoalsAndTasks } = await import("../goalsTasksProjection.js");
  await projectGoalsAndTasks("boot");

  const { getWorkspaceService } = await import("../WorkspaceService.js");
  await getWorkspaceService().ensureSleepJob();
  await getWorkspaceService().ensureWikiWriterJob();

  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(
    `[Gateway] Background: jobs maintenance + home repair complete (${elapsedMs}ms)`,
  );
}
