/**
 * Upload local job runtime to memory server (Phase 4).
 * Git tracks definitions only; Mongo + heartbeat carry runtime across devices.
 */

import type { JobRuntimePatch } from "../../types/cloudRuntime.js";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprApiKey } from "../../utils/keyResolver.js";

export interface JobRuntimeUpsertResponse {
  accepted: boolean;
  jobId: string;
  recordedAt: string;
}

export interface JobRuntimeListResponse {
  patches: JobRuntimePatch[];
  count: number;
}

export async function uploadJobRuntimePatch(
  patch: JobRuntimePatch,
): Promise<boolean> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return false;
  }

  try {
    const res = await cloudApiFetch("/v1/cloud/runtime/job-runtime/upsert", {
      method: "POST",
      body: patch,
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120);
      console.warn(
        `[JobRuntimeCloud] Upsert failed for ${patch.jobId}:`,
        res.status,
        detail,
      );
      return false;
    }
    const body = (await res.json()) as JobRuntimeUpsertResponse;
    return body.accepted !== false;
  } catch (err) {
    console.warn(
      `[JobRuntimeCloud] Upsert error for ${patch.jobId}:`,
      (err as Error).message.slice(0, 120),
    );
    return false;
  }
}

export async function fetchCloudJobRuntimePatches(): Promise<JobRuntimePatch[]> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    return [];
  }

  try {
    const res = await cloudApiFetch("/v1/cloud/runtime/job-runtime", {
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as JobRuntimeListResponse;
    return body.patches ?? [];
  } catch {
    return [];
  }
}
