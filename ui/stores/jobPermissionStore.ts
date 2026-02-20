/**
 * Job Permission Store - Tracks jobs waiting for API key approval.
 *
 * When a job needs permission (key with "ask" setting), the Gateway broadcasts
 * jobs:status-changed with status=waiting_permission. This store surfaces that
 * in the chat so users see "Job X needs your approval" even if the modal
 * is behind another window.
 */

import { create } from "zustand";

export interface PendingJobPermission {
  jobId: string;
  jobName: string;
  keys: string[];
}

interface JobPermissionState {
  pending: PendingJobPermission | null;
  setPending: (p: PendingJobPermission | null) => void;
}

export const useJobPermissionStore = create<JobPermissionState>((set) => ({
  pending: null,
  setPending: (p) => set({ pending: p }),
}));

/**
 * Call once at app root to listen for job permission broadcasts.
 */
export function initJobPermissionListener(): void {
  const handler = (event: Event) => {
    const ev = event as CustomEvent<{
      type: string;
      data?: Record<string, unknown>;
    }>;
    const { type, data } = ev.detail ?? {};
    if (type !== "jobs:status-changed" || !data?.jobId) return;

    const status = data.status as string;
    const jobId = data.jobId as string;

    if (status === "waiting_permission") {
      const keys = (data.waitingPermissionKeys as string[]) ?? [];
      if (keys.length > 0) {
        useJobPermissionStore.getState().setPending({
          jobId,
          jobName: (data.name as string) ?? jobId,
          keys,
        });
      }
    } else if (
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      const { pending } = useJobPermissionStore.getState();
      if (pending?.jobId === jobId) {
        useJobPermissionStore.getState().setPending(null);
      }
    }
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
