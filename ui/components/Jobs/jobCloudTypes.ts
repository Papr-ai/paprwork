export interface CloudJobSummary {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  lastRunAt?: string;
  completedAt?: string;
  lastOutput?: string;
}

export interface JobCloudStatusReport {
  connected: boolean;
  cloudSchedulerActive: boolean;
  summariesById: Record<string, CloudJobSummary>;
  cloudOnlyJobIds: string[];
  checkedAt: string;
}

export type JobExecutionPlacement =
  | "local-only"
  | "local-preferred"
  | "cloud-preferred";
