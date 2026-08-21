/**
 * Cross-side scheduler run lease client (desktop ↔ cloud via memory server).
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";

const HOLDER = "desktop";

interface AcquireResponse {
  acquired: boolean;
  runId?: string;
}

interface ReleaseResponse {
  released: boolean;
}

export async function tryAcquireSchedulerRunLease(
  jobId: string,
  dueAt: string,
): Promise<{ acquired: boolean; runId?: string }> {
  try {
    const res = await cloudApiFetch("/v1/cloud/runtime/scheduler-run-lease/acquire", {
      method: "POST",
      body: { jobId, dueAt, holder: HOLDER },
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      console.warn(
        `[SchedulerRunLease] acquire failed (${res.status}) job=${jobId} dueAt=${dueAt}`,
      );
      return { acquired: false };
    }
    const data = (await res.json()) as AcquireResponse;
    return { acquired: data.acquired, runId: data.runId };
  } catch (err) {
    console.warn(
      `[SchedulerRunLease] acquire error job=${jobId} dueAt=${dueAt}:`,
      err,
    );
    return { acquired: false };
  }
}

export async function releaseSchedulerRunLease(
  jobId: string,
  dueAt: string,
  runId: string,
): Promise<void> {
  try {
    const res = await cloudApiFetch("/v1/cloud/runtime/scheduler-run-lease/release", {
      method: "POST",
      body: { jobId, dueAt, runId, holder: HOLDER },
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      console.warn(
        `[SchedulerRunLease] release failed (${res.status}) job=${jobId} runId=${runId}`,
      );
      return;
    }
    const data = (await res.json()) as ReleaseResponse;
    if (!data.released) {
      console.warn(
        `[SchedulerRunLease] release not confirmed job=${jobId} runId=${runId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[SchedulerRunLease] release error job=${jobId} runId=${runId}:`,
      err,
    );
  }
}
