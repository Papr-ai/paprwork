/**
 * Job Live Logs Store - Accumulates streaming log lines for running jobs.
 *
 * When a job runs, the Gateway broadcasts `jobs:log-line` for each line.
 * This store accumulates them so JobStatusCard can display live output.
 */

import { create } from "zustand";

type LogsState = Map<string, string[]>;

interface JobLiveLogsStore {
  logsByJobId: LogsState;
  appendLine: (jobId: string, line: string) => void;
  clearJob: (jobId: string) => void;
}

export const useJobLiveLogsStore = create<JobLiveLogsStore>((set) => ({
  logsByJobId: new Map(),

  appendLine: (jobId, line) =>
    set((state) => {
      const next = new Map(state.logsByJobId);
      const existing = next.get(jobId) ?? [];
      next.set(jobId, [...existing, line]);
      return { logsByJobId: next };
    }),

  clearJob: (jobId) =>
    set((state) => {
      const next = new Map(state.logsByJobId);
      next.delete(jobId);
      return { logsByJobId: next };
    }),
}));

/**
 * Call once at app root to listen for job log broadcasts.
 */
export function initJobLiveLogsListener(): void {
  const handler = (event: Event) => {
    const ev = event as CustomEvent<{
      type: string;
      data?: Record<string, unknown>;
    }>;
    const { type, data } = ev.detail ?? {};
    if (!data?.jobId) return;

    const jobId = data.jobId as string;

    if (type === "jobs:log-line" && data.line !== undefined) {
      const line = String(data.line);
      useJobLiveLogsStore.getState().appendLine(jobId, line);
    } else if (
      type === "jobs:status-changed" &&
      ["completed", "failed", "cancelled"].includes(String(data.status))
    ) {
      useJobLiveLogsStore.getState().clearJob(jobId);
    }
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
