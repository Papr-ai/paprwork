/**
 * Which jobs are linked to a mini-app (appIds and/or data-sources).
 */

import type { JobRecord } from "./types.js";
import { isStandaloneOnly, jobBelongsToApp } from "./appIds.js";

/** Job IDs linked to at least one mini-app via appIds or data-sources. */
export async function collectLinkedJobIds(
  jobs: readonly JobRecord[],
): Promise<Set<string>> {
  const linked = new Set<string>();

  const { getAppService } = await import("../AppService.js");
  const appService = getAppService();
  await appService.initialize();
  const apps = await appService.listApps();

  for (const app of apps) {
    for (const job of jobs) {
      if (jobBelongsToApp(job.appIds, app.id)) {
        linked.add(job.id);
      }
    }

    try {
      const dataSources = await appService.listAppDataSources(app.id);
      for (const ds of dataSources) {
        if (ds.jobId) {
          linked.add(ds.jobId);
        }
      }
    } catch {
      // App has no data-sources file yet
    }
  }

  return linked;
}

export function isJobLinkedToAnyApp(
  job: Pick<JobRecord, "id" | "appIds">,
  linkedJobIds: ReadonlySet<string>,
): boolean {
  if (isStandaloneOnly(job.appIds ?? [])) {
    return false;
  }
  return linkedJobIds.has(job.id);
}
