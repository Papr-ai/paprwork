import { useCallback, useEffect, useState } from "react";
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
  | "completed"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  name: string;
  type: JobType;
  status: JobStatus;
  folder?: string;
  command?: string;
  dependsOn?: Array<{ jobId: string; onStatus: "completed" | "failed" }>;
  schedule?: {
    enabled: boolean;
    cron?: string;
    intervalMs?: number;
    atTime?: string;
    catchUpMissed?: boolean;
  };
  subAgentId?: string;
  delegatedBy?: string;
  reportChatId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface JobGraphAppLink {
  name: string;
  jobIds: string[];
}

export interface JobGraphEdge {
  from: string;
  to: string;
  onStatus: "completed" | "failed";
}

export interface JobGraph {
  version: 1;
  updatedAt: string;
  folders: Record<string, string[]>;
  appLinks: Record<string, JobGraphAppLink>;
  edges: JobGraphEdge[];
}

export function useJobs() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [graph, setGraph] = useState<JobGraph | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("jobs:list");
      setJobs((response.data as JobRecord[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
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
    }
  }, []);

  const createJob = useCallback(
    async (name: string, type: JobType, command?: string) => {
      setError(null);
      const response = await gateway.send("jobs:create", { name, type, command });
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

  const runJob = useCallback(async (jobId: string) => {
    setError(null);
    const response = await gateway.send("jobs:run", { jobId });
    const updated = response.data as JobRecord;
    setJobs((prev) => prev.map((job) => (job.id === jobId ? updated : job)));
    return updated;
  }, []);

  const stopJob = useCallback(async (jobId: string) => {
    setError(null);
    const response = await gateway.send("jobs:stop", { jobId });
    const updated = response.data as JobRecord;
    setJobs((prev) => prev.map((job) => (job.id === jobId ? updated : job)));
    return updated;
  }, []);

  const loadLogs = useCallback(async (jobId: string) => {
    setSelectedJobId(jobId);
    const response = await gateway.send("jobs:logs", { jobId, maxBytes: 50000 });
    const payload = response.data as { logs?: string };
    setLogs(payload.logs ?? "");
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadGraph();
    const timer = setInterval(() => {
      void loadJobs();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadJobs, loadGraph]);

  return {
    jobs,
    graph,
    selectedJobId,
    logs,
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
