/**
 * Shared jobs state — one poll loop for the whole renderer.
 *
 * MiniAppView used to call useJobs() per mounted iframe (up to 7× jobs:list
 * every 10s). That saturated the gateway WebSocket and made every tab feel slow.
 */

import { create } from "zustand";
import { useEffect } from "react";
import { gateway } from "../src/lib/gateway";
import type { JobCloudStatusReport, JobExecutionPlacement } from "../components/Jobs/jobCloudTypes";
import type { JobGraph, JobRecord, JobStatus } from "../hooks/useJobs";

const JOBS_POLL_MS = 10_000;
const CLOUD_POLL_MS = 30_000;

function jobsFingerprint(jobs: JobRecord[]): string {
  return jobs
    .map(
      (j) =>
        `${j.id}:${j.status}:${j.updatedAt}:${j.lastRunAt ?? ""}:${j.exitCode ?? ""}`,
    )
    .join("|");
}

let jobsPollTimer: ReturnType<typeof setInterval> | null = null;
let cloudPollTimer: ReturnType<typeof setInterval> | null = null;
let fullPollRefCount = 0;
let graphRefCount = 0;
let graphLoadInFlight: Promise<void> | null = null;

function stopFullPolling(): void {
  if (jobsPollTimer) {
    clearInterval(jobsPollTimer);
    jobsPollTimer = null;
  }
  if (cloudPollTimer) {
    clearInterval(cloudPollTimer);
    cloudPollTimer = null;
  }
}

function startFullPolling(): void {
  if (jobsPollTimer || fullPollRefCount <= 0) {
    return;
  }
  const store = useJobsStore.getState();
  void store.loadJobs(false);
  void store.loadGraph();
  void store.loadDefaultModel();
  void store.loadCloudStatus();

  jobsPollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    void useJobsStore.getState().loadJobs(true);
  }, JOBS_POLL_MS);

  cloudPollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    void useJobsStore.getState().loadCloudStatus();
  }, CLOUD_POLL_MS);
}

function onWorkspaceReload(): void {
  const store = useJobsStore.getState();
  void store.loadJobs(true);
  void store.loadGraph();
  void store.loadCloudStatus();
}

function onGatewayBroadcast(
  event: CustomEvent<{ type: string; data?: Record<string, unknown> }>,
): void {
  const { type, data } = event.detail ?? {};
  const store = useJobsStore.getState();

  if (type === "job-recipe-evaluation" && data?.jobId) {
    const jobId = data.jobId as string;
    store.patchJob(jobId, {
      lastEvaluation: {
        runId: data.runId as string,
        score: data.score as number,
        passed: data.passed as boolean,
        timestamp: new Date().toISOString(),
      },
    });
  }

  if (type === "jobs:status-changed" && data?.jobId) {
    const jobId = data.jobId as string;
    store.patchJob(jobId, {
      status: (data.status as JobStatus) ?? undefined,
      completedAt: data.completedAt as string | undefined,
      error: data.error as string | undefined,
      waitingPermissionKeys: data.waitingPermissionKeys as
        | string[]
        | undefined,
    });
  }
}

let listenersInstalled = false;

function ensureGlobalListeners(): void {
  if (listenersInstalled || typeof window === "undefined") {
    return;
  }
  listenersInstalled = true;
  window.addEventListener("papr-workspace-reload", onWorkspaceReload);
  window.addEventListener("gateway-broadcast", onGatewayBroadcast as EventListener);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      return;
    }
    if (fullPollRefCount > 0) {
      void useJobsStore.getState().loadJobs(true);
    }
  });
}

interface JobsStoreState {
  jobs: JobRecord[];
  graph: JobGraph | null;
  graphLoaded: boolean;
  defaultModel: string;
  cloudStatus: JobCloudStatusReport | null;
  loading: boolean;
  error: string | null;
  jobsFingerprint: string;

  patchJob: (jobId: string, patch: Partial<JobRecord>) => void;
  setJobs: (jobs: JobRecord[]) => void;
  loadJobs: (silent?: boolean) => Promise<void>;
  loadGraph: () => Promise<void>;
  loadDefaultModel: () => Promise<void>;
  loadCloudStatus: () => Promise<void>;
  updateJobPlacement: (
    jobId: string,
    executionCapability: JobExecutionPlacement,
  ) => Promise<JobRecord>;
}

export const useJobsStore = create<JobsStoreState>((set, get) => ({
  jobs: [],
  graph: null,
  graphLoaded: false,
  defaultModel: "gpt-5-6-sol",
  cloudStatus: null,
  loading: false,
  error: null,
  jobsFingerprint: "",

  patchJob: (jobId, patch) => {
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === jobId ? { ...job, ...patch } : job,
      ),
    }));
  },

  setJobs: (jobs) => {
    set({
      jobs,
      jobsFingerprint: jobsFingerprint(jobs),
    });
  },

  loadJobs: async (silent = false) => {
    if (!silent) {
      set({ loading: true, error: null });
    }
    try {
      const response = await gateway.send("jobs:list");
      const incoming = (response.data as JobRecord[]) ?? [];
      const fp = jobsFingerprint(incoming);
      if (fp !== get().jobsFingerprint) {
        set({ jobs: incoming, jobsFingerprint: fp, error: null });
      } else if (!silent) {
        set({ error: null });
      }
    } catch (err) {
      if (!silent) {
        set({
          error: err instanceof Error ? err.message : "Failed to load jobs",
        });
      }
    } finally {
      if (!silent) {
        set({ loading: false });
      }
    }
  },

  loadGraph: async () => {
    if (graphLoadInFlight) {
      await graphLoadInFlight;
      return;
    }
    graphLoadInFlight = (async () => {
      try {
        const response = await gateway.send("jobs:graph");
        const payload = response.data as { graph: JobGraph | null };
        if (payload.graph) {
          set({ graph: payload.graph });
        }
      } catch {
        /* optional */
      } finally {
        set({ graphLoaded: true });
      }
    })();
    try {
      await graphLoadInFlight;
    } finally {
      graphLoadInFlight = null;
    }
  },

  loadDefaultModel: async () => {
    try {
      const response = await gateway.send("jobs:default-model");
      const payload = response.data as { provider: string; model: string };
      if (payload.model) {
        const display = payload.provider
          ? `${payload.provider}/${payload.model}`
          : payload.model;
        set({ defaultModel: display });
      }
    } catch {
      /* fallback already set */
    }
  },

  loadCloudStatus: async () => {
    try {
      const response = await gateway.send("jobs:cloud-status", {});
      if (response.success && response.data) {
        set({ cloudStatus: response.data as JobCloudStatusReport });
      }
    } catch {
      /* non-fatal */
    }
  },

  updateJobPlacement: async (jobId, executionCapability) => {
    const response = await gateway.send("jobs:update", {
      jobId,
      executionCapability,
    });
    const updated = response.data as JobRecord;
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === jobId ? updated : job)),
    }));
    return updated;
  },
}));

/** Full jobs polling — JobsView / MiniAppJobsView only. */
export function subscribeJobsFullPolling(): () => void {
  ensureGlobalListeners();
  fullPollRefCount += 1;
  startFullPolling();
  return () => {
    fullPollRefCount = Math.max(0, fullPollRefCount - 1);
    if (fullPollRefCount === 0) {
      stopFullPolling();
    }
  };
}

/** Graph only — MiniApp publish bar linked-job count. */
export function subscribeJobsGraph(): () => void {
  ensureGlobalListeners();
  graphRefCount += 1;
  if (graphRefCount === 1 || !useJobsStore.getState().graphLoaded) {
    void useJobsStore.getState().loadGraph();
  }
  return () => {
    graphRefCount = Math.max(0, graphRefCount - 1);
  };
}

/** Linked job count for one app without starting jobs:list polling. */
export function useAppLinkedJobCount(appId: string): number {
  useEffect(() => subscribeJobsGraph(), []);
  return useJobsStore(
    (state) => state.graph?.appLinks[appId]?.jobIds.length ?? 0,
  );
}
