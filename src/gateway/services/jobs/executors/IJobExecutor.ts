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
  /**
   * Called before requesting permission for "ask" keys. Allows JobsService to
   * set status to waiting_permission and broadcast so chat/job page can surface.
   */
  onWaitingPermission?: (keys: string[]) => Promise<void>;
  /**
   * Called after all "ask" keys have been approved. Allows JobsService to
   * set status back to running before the job command is executed.
   */
  onResumingAfterPermission?: () => Promise<void>;
  /**
   * Request permission for an API key. Returns true if approved, false if denied.
   * Used when job command has ${KEY_NAME} and key has permission "ask".
   */
  requestKeyPermission?: (
    keyName: string,
    context: { jobId: string; jobName: string },
  ) => Promise<boolean>;
}

export interface ExecutorLaunchResult {
  mode: "process" | "immediate";
  command: string;
  process?: ChildProcessWithoutNullStreams;
  exitCode?: number;
  outputMessage?: string;
  errorMessage?: string;
  /** Secret values substituted into the command — for log redaction without re-fetching all keys */
  sanitizationValues?: string[];
}

export interface IJobExecutor {
  canExecute(type: JobType): boolean;
  launch(params: ExecutorLaunchParams): Promise<ExecutorLaunchResult>;
}
