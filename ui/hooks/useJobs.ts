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

export function useJobs() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
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

  const createJob = useCallback(
    async (name: string, type: JobType, command?: string) => {
      setError(null);
      const response = await gateway.send("jobs:create", { name, type, command });
      const job = response.data as JobRecord;
      setJobs((prev) => [job, ...prev.filter((item) => item.id !== job.id)]);
      return job;
    },
    [],
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
      return job;
    },
    [],
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
    const timer = setInterval(() => {
      void loadJobs();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadJobs]);

  return {
    jobs,
    selectedJobId,
    logs,
    loading,
    error,
    loadJobs,
    createJob,
    createScheduledJob,
    runJob,
    stopJob,
    loadLogs,
  };
}
