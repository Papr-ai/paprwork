import type { CatalogAutomation } from "../../core/types/catalogAutomation.js";
import { buildCatalogAutomationForApp } from "../../core/utils/catalogAutomation.js";

export async function resolveCatalogAutomationForApp(
  appId: string,
): Promise<CatalogAutomation | null> {
  const { getJobsService } = await import("./JobsService.js");
  const jobsService = getJobsService();
  await jobsService.initialize();
  const jobs = await jobsService.listJobs({ appId });
  return buildCatalogAutomationForApp(appId, jobs);
}
