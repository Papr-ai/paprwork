import { useEffect } from "react";
import {
  subscribeJobRunDashboardPolling,
  useJobRunDashboardStore,
} from "../stores/jobRunDashboardStore";

export interface JobRunDashboardEntry {
  runId: string;
  jobId: string;
  jobName: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  duration?: number;
}

export interface JobRunDashboardTopJob {
  jobId: string;
  jobName: string;
  runs: number;
  completed: number;
  failed: number;
}

export interface JobRunDashboard {
  totalJobs: number;
  activeJobs: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  successRate: number;
  topJobs: JobRunDashboardTopJob[];
  recentRuns: JobRunDashboardEntry[];
}

export function useJobRunDashboard() {
  const dashboard = useJobRunDashboardStore((state) => state.dashboard);
  const loading = useJobRunDashboardStore((state) => state.loading);
  const error = useJobRunDashboardStore((state) => state.error);
  const ensureLoaded = useJobRunDashboardStore((state) => state.ensureLoaded);
  const loadDashboard = useJobRunDashboardStore((state) => state.loadDashboard);

  useEffect(() => {
    void ensureLoaded();
    return subscribeJobRunDashboardPolling();
  }, [ensureLoaded]);

  return {
    dashboard,
    loading: loading && dashboard === null,
    error,
    reload: loadDashboard,
  };
}
