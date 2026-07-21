/**
 * Mini-app client for job push events (SSE).
 *
 * Copy this file into your app OR import from `/__papr__/papr-job-events.ts`.
 *
 * Usage:
 *   import { subscribeJobEvents } from './papr-job-events.ts';
 *
 *   const unsub = subscribeJobEvents({
 *     jobIds: [SCORER_JOB_ID],
 *     onStatusChanged: (data) => { if (data.status === 'completed') reload(); },
 *     onProgress: (data) => { if (data.event === 'score_count') updateLabel(data.payload); },
 *   });
 */

export interface JobStatusChangedEvent {
  jobId: string;
  name?: string;
  status: string;
  completedAt?: string;
  error?: string;
  lastOutput?: string;
}

export interface JobProgressEvent {
  jobId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface DbChangedEvent {
  jobId?: string;
  dbId?: string;
  tables: string[];
}

export interface SubscribeJobEventsOptions {
  /** Subscribe to specific jobs (recommended). Omit to receive all job events. */
  jobIds?: string[];
  /** Subscribe to db-changed events for registry databases. */
  dbIds?: string[];
  onStatusChanged?: (data: JobStatusChangedEvent) => void;
  onProgress?: (data: JobProgressEvent) => void;
  onLogLine?: (data: { jobId: string; line: string }) => void;
  onDbChanged?: (data: DbChangedEvent) => void;
  onError?: (error: Event) => void;
}

function buildEventsUrl(
  jobIds: string[] | undefined,
  dbIds: string[] | undefined,
): string {
  const base = "/api/jobs/events";
  const params = new URLSearchParams();
  if (jobIds && jobIds.length > 0) {
    params.set("jobIds", jobIds.join(","));
  }
  if (dbIds && dbIds.length > 0) {
    params.set("dbIds", dbIds.join(","));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function parseEventData<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribe to job lifecycle + progress events via Server-Sent Events.
 * Returns an unsubscribe function — call on view teardown.
 */
export function subscribeJobEvents(
  options: SubscribeJobEventsOptions,
): () => void {
  const source = new EventSource(buildEventsUrl(options.jobIds, options.dbIds));

  source.addEventListener("jobs:status-changed", (ev: MessageEvent) => {
    const data = parseEventData<JobStatusChangedEvent>(String(ev.data));
    if (data) {
      options.onStatusChanged?.(data);
    }
  });

  source.addEventListener("jobs:progress", (ev: MessageEvent) => {
    const data = parseEventData<JobProgressEvent>(String(ev.data));
    if (data) {
      options.onProgress?.(data);
    }
  });

  source.addEventListener("jobs:db-changed", (ev: MessageEvent) => {
    const data = parseEventData<DbChangedEvent>(ev.data);
    if (data && options.onDbChanged) {
      options.onDbChanged(data);
    }
  });

  source.addEventListener("jobs:log-line", (ev: MessageEvent) => {
    const data = parseEventData<{ jobId: string; line: string }>(String(ev.data));
    if (data) {
      options.onLogLine?.(data);
    }
  });

  source.onerror = (err) => {
    options.onError?.(err);
  };

  return () => {
    source.close();
  };
}

/**
 * Run a job and refresh when it completes (no polling loop).
 */
export async function runJobAndWaitForComplete(
  jobId: string,
  params?: Record<string, string>,
): Promise<JobStatusChangedEvent> {
  return new Promise((resolve, reject) => {
    const unsub = subscribeJobEvents({
      jobIds: [jobId],
      onStatusChanged: (data) => {
        if (data.jobId !== jobId) {
          return;
        }
        if (
          data.status === "completed" ||
          data.status === "failed" ||
          data.status === "cancelled"
        ) {
          unsub();
          resolve(data);
        }
      },
      onError: () => {
        /* EventSource reconnects automatically */
      },
    });

    void fetch("/api/jobs/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, params }),
    }).catch((err: unknown) => {
      unsub();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
