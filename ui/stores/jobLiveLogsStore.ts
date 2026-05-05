/**
 * Job Live Logs Store - Accumulates streaming log lines for running jobs.
 *
 * When a job runs, the Gateway broadcasts `jobs:log-line` for each line.
 * This store accumulates them so JobStatusCard can display live output.
 * Also tracks job names from status-changed broadcasts.
 */

import { create } from "zustand";
import { gateway } from "../src/lib/gateway";

type LogsState = Map<string, string[]>;
type NamesState = Map<string, string>;
type FailedFetchesState = Set<string>;

interface JobLiveLogsStore {
  logsByJobId: LogsState;
  namesByJobId: NamesState;
  failedFetches: FailedFetchesState;
  appendLine: (jobId: string, line: string) => void;
  setJobName: (jobId: string, name: string) => void;
  getJobName: (jobId: string) => string | undefined;
  fetchJobName: (jobId: string) => Promise<string | undefined>;
  clearJob: (jobId: string) => void;
}

export const useJobLiveLogsStore = create<JobLiveLogsStore>((set, get) => ({
  logsByJobId: new Map(),
  namesByJobId: new Map(),
  failedFetches: new Set(),

  appendLine: (jobId, line) =>
    set((state) => {
      const next = new Map(state.logsByJobId);
      const existing = next.get(jobId) ?? [];
      next.set(jobId, [...existing, line]);
      return { logsByJobId: next };
    }),

  setJobName: (jobId, name) =>
    set((state) => {
      const next = new Map(state.namesByJobId);
      next.set(jobId, name);
      return { namesByJobId: next };
    }),

  getJobName: (jobId) => get().namesByJobId.get(jobId),

  fetchJobName: async (jobId) => {
    // Check if we already have it
    const existing = get().namesByJobId.get(jobId);
    if (existing) return existing;

    // Don't retry if we already failed to fetch this job
    if (get().failedFetches.has(jobId)) return undefined;

    // Fetch from gateway
    try {
      const response = await gateway.send("jobs:get", { jobId });
      const job = response.data as { name?: string };
      if (job?.name) {
        get().setJobName(jobId, job.name);
        return job.name;
      }
    } catch (error) {
      console.warn(
        `[jobLiveLogsStore] Failed to fetch job name for ${jobId}:`,
        error,
      );
      // Mark this job as failed so we don't retry
      set((state) => {
        const next = new Set(state.failedFetches);
        next.add(jobId);
        return { failedFetches: next };
      });
    }
    return undefined;
  },

  clearJob: (jobId) =>
    set((state) => {
      const nextLogs = new Map(state.logsByJobId);
      const nextNames = new Map(state.namesByJobId);
      const nextFailed = new Set(state.failedFetches);
      nextLogs.delete(jobId);
      nextNames.delete(jobId);
      nextFailed.delete(jobId);
      return { logsByJobId: nextLogs, namesByJobId: nextNames, failedFetches: nextFailed };
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
    } else if (type === "jobs:status-changed") {
      // Track job name from status-changed broadcasts
      if (data.name) {
        useJobLiveLogsStore.getState().setJobName(jobId, String(data.name));
      }
      // Clear logs when job finishes
      if (["completed", "failed", "cancelled"].includes(String(data.status))) {
        useJobLiveLogsStore.getState().clearJob(jobId);
      }
    }
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
