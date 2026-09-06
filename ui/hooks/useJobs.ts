import { useCallback, useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";
import type { JobCloudStatusReport, JobExecutionPlacement } from "../components/Jobs/jobCloudTypes";
import {
  subscribeJobsFullPolling,
  useJobsStore,
} from "../stores/jobsStore";

export type JobType =
  | "shell"
  | "bash"
  | "node"
  | "python"
  | "swift"
  | "agent"
  | "subagent";
export type JobStatus =
  | "pending"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  name: string;
  type: JobType;
  status: JobStatus;
  appIds: string[];
  folder?: string;
  command?: string;
  dependsOn?: Array<{ jobId: string; onStatus: "completed" | "failed" }>;
  schedule?: {
    enabled: boolean;
    cron?: string;
    timezone?: string;
    intervalMs?: number;
    atTime?: string;
    catchUpMissed?: boolean;
  };
  scheduleState?: {
    nextRunAt?: string;
    lastScheduledRunAt?: string;
    lastTriggeredAt?: string;
    currentIdempotencyKey?: string;
    lastIdempotencyKey?: string;
  };
  subAgentId?: string;
  delegatedBy?: string;
  reportChatId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  waitingPermissionKeys?: string[];
  recipe?: {
    enabled: boolean;
    autoEvaluate?: boolean;
    passThreshold?: number;
  };
  lastEvaluation?: {
    runId: string;
    score: number;
    passed: boolean;
    timestamp: string;
  };
  /** Scheduled execution placement when cloud sync is on */
  executionCapability?: "local-only" | "local-preferred" | "cloud-preferred" | "cloud-capable";
  /** Where the most recent run executed */
  lastRunSource?: string;
}

export interface JobGraphAppLink {
  name: string;
  jobIds: string[];
}

export interface JobGraphEdge {
  from: string;
  to: string;
  onStatus: "completed" | "failed";
  isRuntimeCall?: boolean;
  autoTrigger?: boolean;
}

export interface JobGraph {
  version: 1;
  updatedAt: string;
  folders: Record<string, string[]>;
  appLinks: Record<string, JobGraphAppLink>;
  edges: JobGraphEdge[];
}

export function useJobs() {
  const jobs = useJobsStore((state) => state.jobs);
  const graph = useJobsStore((state) => state.graph);
  const graphLoaded = useJobsStore((state) => state.graphLoaded);
  const defaultModel = useJobsStore((state) => state.defaultModel);
  const cloudStatus = useJobsStore((state) => state.cloudStatus);
  const loading = useJobsStore((state) => state.loading);
  const error = useJobsStore((state) => state.error);
  const loadJobs = useJobsStore((state) => state.loadJobs);
  const loadGraph = useJobsStore((state) => state.loadGraph);
  const loadCloudStatus = useJobsStore((state) => state.loadCloudStatus);
  const updateJobPlacementStore = useJobsStore(
    (state) => state.updateJobPlacement,
  );
  const setJobs = useJobsStore((state) => state.setJobs);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logsByJobId, setLogsByJobId] = useState<Record<string, string>>({});
  const [updatingPlacementJobId, setUpdatingPlacementJobId] = useState<
    string | null
  >(null);

  useEffect(() => subscribeJobsFullPolling(), []);

  const createJob = useCallback(
    async (name: string, type: JobType, command?: string) => {
      useJobsStore.setState({ error: null });
      const response = await gateway.send("jobs:create", {
        name,
        type,
        command,
      });
      const job = response.data as JobRecord;
      setJobs([job, ...jobs.filter((item) => item.id !== job.id)]);
      void loadGraph();
      return job;
    },
    [jobs, loadGraph, setJobs],
  );

  const createScheduledJob = useCallback(
    async (
      name: string,
      type: JobType,
      command: string | undefined,
      schedule?: JobRecord["schedule"],
    ) => {
      useJobsStore.setState({ error: null });
      const response = await gateway.send("jobs:create", {
        name,
        type,
        command,
        schedule,
      });
      const job = response.data as JobRecord;
      setJobs([job, ...jobs.filter((item) => item.id !== job.id)]);
      void loadGraph();
      return job;
    },
    [jobs, loadGraph, setJobs],
  );

  const loadLogs = useCallback(async (jobId: string) => {
    setSelectedJobId(jobId);
    const response = await gateway.send("jobs:logs", {
      jobId,
      maxBytes: 50000,
    });
    const payload = response.data as { logs?: string };
    setLogsByJobId((prev) => ({
      ...prev,
      [jobId]: payload.logs ?? "",
    }));
  }, []);

  const runJob = useCallback(
    async (jobId: string, runtime: "local" | "cloud" = "local") => {
      useJobsStore.setState({ error: null });
      const response = await gateway.send("jobs:run", { jobId, runtime });
      const updated = response.data as JobRecord;
      useJobsStore.getState().patchJob(jobId, updated);
      void loadLogs(jobId);
      return updated;
    },
    [loadLogs],
  );

  const stopJob = useCallback(async (jobId: string) => {
    useJobsStore.setState({ error: null });
    const response = await gateway.send("jobs:stop", { jobId });
    const updated = response.data as JobRecord;
    useJobsStore.getState().patchJob(jobId, updated);
    return updated;
  }, []);

  const updateJobPlacement = useCallback(
    async (jobId: string, executionCapability: JobExecutionPlacement) => {
      setUpdatingPlacementJobId(jobId);
      useJobsStore.setState({ error: null });
      try {
        return await updateJobPlacementStore(jobId, executionCapability);
      } finally {
        setUpdatingPlacementJobId(null);
      }
    },
    [updateJobPlacementStore],
  );

  const deleteJob = useCallback(
    async (jobId: string, deleteFiles = true, deleteTursoDb = true) => {
      useJobsStore.setState({ error: null });
      const response = await gateway.send("jobs:delete", {
        jobId,
        deleteFiles,
        deleteTursoDb,
      });
      const result = response.data as {
        deleted: boolean;
        tursoDbDeleted?: boolean;
      };
      if (result.deleted) {
        setJobs(jobs.filter((job) => job.id !== jobId));
        void loadGraph();
        void loadCloudStatus();
      }
      return result;
    },
    [jobs, loadGraph, loadCloudStatus, setJobs],
  );

  return {
    jobs,
    graph,
    graphLoaded,
    selectedJobId,
    logsByJobId,
    defaultModel,
    loading,
    error,
    loadJobs,
    loadGraph,
    createJob,
    createScheduledJob,
    runJob,
    stopJob,
    deleteJob,
    loadLogs,
    cloudStatus,
    loadCloudStatus,
    updateJobPlacement,
    updatingPlacementJobId,
  };
}
