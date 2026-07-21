import { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../src/lib/gateway";

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

function jobsFingerprint(jobs: JobRecord[]): string {
  return jobs
    .map((j) => `${j.id}:${j.status}:${j.updatedAt}:${j.lastRunAt ?? ""}:${j.exitCode ?? ""}`)
    .join("|");
}

export function useJobs() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [graph, setGraph] = useState<JobGraph | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logsByJobId, setLogsByJobId] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("gpt-5-6-sol");
  const fingerprintRef = useRef("");
  const initialLoadDone = useRef(false);

  const loadJobs = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await gateway.send("jobs:list");
      const incoming = (response.data as JobRecord[]) ?? [];
      const fp = jobsFingerprint(incoming);
      if (fp !== fingerprintRef.current) {
        fingerprintRef.current = fp;
        setJobs(incoming);
      }
      if (!silent) setError(null);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "Failed to load jobs");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const response = await gateway.send("jobs:graph");
      const payload = response.data as { graph: JobGraph | null };
      if (payload.graph) {
        setGraph(payload.graph);
      }
    } catch {
      // graph is optional — don't surface errors
    } finally {
      setGraphLoaded(true);
    }
  }, []);

  const loadDefaultModel = useCallback(async () => {
    try {
      const response = await gateway.send("jobs:default-model");
      const payload = response.data as { provider: string; model: string };
      if (payload.model) {
        const display = payload.provider ? `${payload.provider}/${payload.model}` : payload.model;
        setDefaultModel(display);
      }
    } catch {
      // fallback already set to gpt-5.5
    }
  }, []);

  const createJob = useCallback(
    async (name: string, type: JobType, command?: string) => {
      setError(null);
      const response = await gateway.send("jobs:create", {
        name,
        type,
        command,
      });
      const job = response.data as JobRecord;
      setJobs((prev) => [job, ...prev.filter((item) => item.id !== job.id)]);
      void loadGraph();
      return job;
    },
    [loadGraph],
  );

  const createScheduledJob = useCallback(
    async (
      name: string,
      type: JobType,
      command: string | undefined,
      schedule?: JobRecord["schedule"],
    ) => {
      setError(null);
      const response = await gateway.send("jobs:create", {
        name,
        type,
        command,
        schedule,
      });
      const job = response.data as JobRecord;
      setJobs((prev) => [job, ...prev.filter((item) => item.id !== job.id)]);
      void loadGraph();
      return job;
    },
    [loadGraph],
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
      setError(null);
      const response = await gateway.send("jobs:run", { jobId, runtime });
      const updated = response.data as JobRecord;
      setJobs((prev) => prev.map((job) => (job.id === jobId ? updated : job)));
      void loadLogs(jobId);
      return updated;
    },
    [loadLogs],
  );

  const stopJob = useCallback(async (jobId: string) => {
    setError(null);
    const response = await gateway.send("jobs:stop", { jobId });
    const updated = response.data as JobRecord;
    setJobs((prev) => prev.map((job) => (job.id === jobId ? updated : job)));
    return updated;
  }, []);

  useEffect(() => {
    void loadJobs(false);
    void loadGraph();
    void loadDefaultModel();
    initialLoadDone.current = true;
    const timer = setInterval(() => {
      void loadJobs(true);
    }, 10000);

    const handler = (
      event: CustomEvent<{ type: string; data?: Record<string, unknown> }>,
    ) => {
      const { type, data } = event.detail ?? {};
      if (type === "job-recipe-evaluation" && data?.jobId) {
        const jobId = data.jobId as string;
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== jobId) return j;
            return {
              ...j,
              lastEvaluation: {
                runId: data.runId as string,
                score: data.score as number,
                passed: data.passed as boolean,
                timestamp: new Date().toISOString(),
              },
            };
          }),
        );
      }
      if (type === "jobs:status-changed" && data?.jobId) {
        const jobId = data.jobId as string;
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== jobId) return j;
            return {
              ...j,
              status: (data.status as JobStatus) ?? j.status,
              completedAt: data.completedAt as string | undefined,
              error: data.error as string | undefined,
              lastOutput: data.lastOutput as string | undefined,
              waitingPermissionKeys: data.waitingPermissionKeys as
                | string[]
                | undefined,
            };
          }),
        );
      }
    };
    window.addEventListener("gateway-broadcast", handler as EventListener);
    return () => {
      clearInterval(timer);
      window.removeEventListener("gateway-broadcast", handler as EventListener);
    };
  }, [loadJobs, loadGraph]);

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
    loadLogs,
  };
}
