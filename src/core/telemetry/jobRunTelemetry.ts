/**
 * Shared shape for "how much work did agents and jobs actually do".
 *
 * The unit of value in Paprwork is a mini-app that runs itself — "My Papr Books"
 * is one app, a handful of agents, some jobs, and a stream of runs. Counting
 * runs alone understates that: a 40-minute accounting agent and a 200ms cron
 * ping are both "1 run". Duration is what separates them.
 *
 * Local and cloud runs are emitted from different services (JobsService vs
 * CloudJobRunService). Both build dimensions here so a run is attributed the
 * same way regardless of where it executed — otherwise `sum(duration_hours)`
 * silently means "local only".
 */

/** Where the run actually executed. */
export type JobRunSurface = "local" | "cloud";

/** What started this run. Separates human intent from automation volume. */
export type JobRunTrigger = "manual" | "scheduled" | "dependency";

/**
 * Agent jobs do LLM reasoning work; script jobs are deterministic pipelines.
 * Both are "work", but only agent hours represent autonomous labour, which is
 * the number that makes "agents doing work for you" measurable.
 */
export type JobAgentKind = "agent" | "script";

export interface JobRunTelemetryInput {
  jobId: string;
  jobType: string;
  /** Mini-app UUIDs this job belongs to. First one is the attribution target. */
  appIds?: string[];
  durationMs: number;
  surface: JobRunSurface;
  trigger?: JobRunTrigger;
  /** Present on subagent jobs — indicates a named custom agent profile. */
  subAgentId?: string;
  scheduled?: boolean;
}

export interface JobRunTelemetryDimensions {
  job_id: string;
  job_type: string;
  /** Primary owning mini-app. Absent for standalone jobs. */
  app_id?: string;
  /** Jobs may serve several apps; count keeps that visible without leaking ids. */
  app_count: number;
  is_standalone: boolean;
  agent_kind: JobAgentKind;
  is_agent: boolean;
  has_custom_agent: boolean;
  surface: JobRunSurface;
  trigger: JobRunTrigger;
  duration_ms: number;
  /**
   * Pre-divided so Amplitude charts can sum hours directly. Doing this in the
   * chart requires a formula on every panel; doing it here makes
   * `sum(duration_hours)` the whole query.
   */
  duration_hours: number;
}

/** Sentinel used by create_job for jobs deliberately not tied to any app. */
const STANDALONE = "__standalone__";

function realAppIds(appIds?: string[]): string[] {
  return (appIds ?? []).filter((id) => id && id !== STANDALONE);
}

export function isAgentJobType(jobType: string): boolean {
  return jobType === "agent" || jobType === "subagent";
}

/**
 * Round to 4dp (~0.36s). Amplitude sums floats fine, but unbounded precision
 * makes event payloads noisy and property values harder to eyeball in the UI.
 */
function toHours(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round((durationMs / 3_600_000) * 10_000) / 10_000;
}

export function buildJobRunDimensions(
  input: JobRunTelemetryInput,
): JobRunTelemetryDimensions {
  const apps = realAppIds(input.appIds);
  const isAgent = isAgentJobType(input.jobType);
  const durationMs =
    Number.isFinite(input.durationMs) && input.durationMs > 0
      ? Math.round(input.durationMs)
      : 0;

  const trigger: JobRunTrigger =
    input.trigger ?? (input.scheduled ? "scheduled" : "manual");

  return {
    job_id: input.jobId,
    job_type: input.jobType,
    app_id: apps[0],
    app_count: apps.length,
    is_standalone: apps.length === 0,
    agent_kind: isAgent ? "agent" : "script",
    is_agent: isAgent,
    has_custom_agent: isAgent && !!input.subAgentId,
    surface: input.surface,
    trigger,
    duration_ms: durationMs,
    duration_hours: toHours(durationMs),
  };
}
