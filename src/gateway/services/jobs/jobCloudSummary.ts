/**
 * Fetch cloud-side job summaries from the memory server (Mongo catalog + runtime).
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";

export interface CloudJobSummary {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  lastRunAt?: string;
  completedAt?: string;
  lastOutput?: string;
}

export interface JobCloudStatusReport {
  connected: boolean;
  cloudSchedulerActive: boolean;
  summariesById: Record<string, CloudJobSummary>;
  /** Job IDs present in cloud catalog but not in local jobs.json */
  cloudOnlyJobIds: string[];
  checkedAt: string;
}

interface CloudJobsListResponse {
  jobs?: CloudJobSummary[];
  count?: number;
}

export async function fetchCloudJobSummaries(
  localJobIds: string[],
): Promise<JobCloudStatusReport> {
  const checkedAt = new Date().toISOString();
  const localIdSet = new Set(localJobIds);

  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return {
      connected: false,
      cloudSchedulerActive: false,
      summariesById: {},
      cloudOnlyJobIds: [],
      checkedAt,
    };
  }

  const { isCloudSchedulerAuthoritative } = await import(
    "../../utils/cloudSchedulerAuthority.js"
  );
  const cloudSchedulerActive = await isCloudSchedulerAuthoritative();

  try {
    const res = await cloudApiFetch("/v1/cloud/runtime/jobs", {
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      return {
        connected: true,
        cloudSchedulerActive,
        summariesById: {},
        cloudOnlyJobIds: [],
        checkedAt,
      };
    }

    const body = (await res.json()) as CloudJobsListResponse;
    const summariesById: Record<string, CloudJobSummary> = {};
    const cloudOnlyJobIds: string[] = [];

    for (const entry of body.jobs ?? []) {
      if (!entry?.id) continue;
      summariesById[entry.id] = entry;
      if (!localIdSet.has(entry.id)) {
        cloudOnlyJobIds.push(entry.id);
      }
    }

    return {
      connected: true,
      cloudSchedulerActive,
      summariesById,
      cloudOnlyJobIds,
      checkedAt,
    };
  } catch {
    return {
      connected: true,
      cloudSchedulerActive,
      summariesById: {},
      cloudOnlyJobIds: [],
      checkedAt,
    };
  }
}
