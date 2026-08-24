import type { JobRecord, JobType } from "../hooks/useJobs";
import { isDelegationRun } from "./delegationJobGrouping";

export type JobTypeFilter =
  | "all"
  | "agent"
  | "subagent"
  | "delegation"
  | "python"
  | "shell"
  | "node"
  | "swift";

export const JOB_TYPE_FILTER_OPTIONS: Array<{
  value: JobTypeFilter;
  label: string;
}> = [
  { value: "all", label: "All types" },
  { value: "agent", label: "Agent" },
  { value: "subagent", label: "Sub-agent" },
  { value: "delegation", label: "Delegations" },
  { value: "python", label: "Python" },
  { value: "shell", label: "Shell" },
  { value: "node", label: "Node" },
  { value: "swift", label: "Swift" },
];

const SCRIPT_TYPES = new Set<JobType>(["python", "bash", "shell", "node", "swift"]);

export function matchesJobTypeFilter(job: JobRecord, filter: JobTypeFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "delegation") {
    return isDelegationRun(job);
  }
  if (filter === "subagent") {
    return job.type === "subagent" && !isDelegationRun(job);
  }
  if (filter === "agent") {
    return job.type === "agent";
  }
  if (filter === "python") {
    return job.type === "python";
  }
  if (filter === "shell") {
    return job.type === "bash" || job.type === "shell";
  }
  if (filter === "node") {
    return job.type === "node";
  }
  if (filter === "swift") {
    return job.type === "swift";
  }
  return true;
}

export function isScriptJobType(type: JobType): boolean {
  return SCRIPT_TYPES.has(type);
}
