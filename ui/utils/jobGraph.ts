import type { JobGraph } from "../hooks/useJobs";

/** Virtual sidebar id for jobs not linked to any mini-app */
export const STANDALONE_WORKFLOW_ID = "__standalone__";

/** List view treats workflow-only ids as "All Apps" (no filter). */
export function resolveListAppFilterId(appId: string | null): string | null {
  if (!appId || appId === STANDALONE_WORKFLOW_ID) {
    return null;
  }
  return appId;
}

export function findAppIdForJob(
  graph: JobGraph | null,
  jobId: string,
): string | null {
  if (!graph) return null;
  for (const [appId, link] of Object.entries(graph.appLinks)) {
    if (link.jobIds.includes(jobId)) {
      return appId;
    }
  }
  return null;
}

export function getUnlinkedJobIds(
  graph: JobGraph | null,
  jobIds: string[],
): string[] {
  if (!graph) return jobIds;
  const linked = new Set<string>();
  for (const link of Object.values(graph.appLinks)) {
    for (const jobId of link.jobIds) {
      linked.add(jobId);
    }
  }
  return jobIds.filter((id) => !linked.has(id));
}

export function resolveWorkflowTarget(
  graph: JobGraph | null,
  jobId: string,
): { appId: string; isStandalone: boolean } {
  const appId = findAppIdForJob(graph, jobId);
  if (appId) {
    return { appId, isStandalone: false };
  }
  return { appId: STANDALONE_WORKFLOW_ID, isStandalone: true };
}
