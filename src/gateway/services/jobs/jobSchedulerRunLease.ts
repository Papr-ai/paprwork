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
): Promise<{ acquired: boolean; runId?: string; unavailable?: boolean }> {
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
      // Contention comes back as 200 { acquired: false }. A non-2xx means the
      // lease service could not answer, which is not the same as being refused.
      return { acquired: false, unavailable: true };
    }
    const data = (await res.json()) as AcquireResponse;
    return { acquired: data.acquired, runId: data.runId };
  } catch (err) {
    console.warn(
      `[SchedulerRunLease] acquire error job=${jobId} dueAt=${dueAt}:`,
      err,
    );
    // Logged out, offline, or memory unreachable.
    return { acquired: false, unavailable: true };
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
