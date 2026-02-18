import type { ChildProcessWithoutNullStreams } from "child_process";
import type { JobRecord, JobType } from "../types.js";

export interface ExecutorLaunchParams {
  runId: string;
  job: JobRecord;
  jobDir: string;
  defaultCommandByType: Record<Exclude<JobType, "agent" | "subagent">, string>;
  appendLog: (line: string) => Promise<void>;
  /**
   * Per-invocation runtime parameters, injected as env vars for this run only.
   * Distinct from API keys (inherited from gateway process env) and from
   * job-level config env set in job.json.
   * e.g. { THREAD_ID: "abc123", MODE: "regen" }
   */
  runtimeParams?: Record<string, string>;
}

export interface ExecutorLaunchResult {
  mode: "process" | "immediate";
  command: string;
  process?: ChildProcessWithoutNullStreams;
  exitCode?: number;
  outputMessage?: string;
  errorMessage?: string;
}

export interface IJobExecutor {
  canExecute(type: JobType): boolean;
  launch(params: ExecutorLaunchParams): Promise<ExecutorLaunchResult>;
}
