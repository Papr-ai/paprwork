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
 *     debounceMs: 300,
 *     onDbChanged: () => loadData(),
 *     onStatusChanged: (data) => { if (data.status === 'completed') reload(); },
 *     onProgress: (data) => { if (data.event === 'score_count') updateLabel(data.payload); },
 *   });
 */

import {
  registerPausablePreviewResource,
} from "./papr-preview-lifecycle.ts";

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

interface DataSourcesConfig {
  sources?: Array<{
    jobId?: string;
    databaseId?: string;
    dbId?: string;
    registryId?: string;
  }>;
}

export interface SubscribeJobEventsOptions {
  /** Subscribe to specific jobs (recommended). Omit to receive all job events. */
  jobIds?: string[];
  /** Subscribe to db-changed events for registry databases. */
  dbIds?: string[];
  /**
   * Debounce `onDbChanged` (ms). Server coalesces job db-changed to ~400ms; use 200–500ms
   * when `onDbChanged` triggers heavy loadData() so bursts collapse to one refresh.
   * Default: 0 (no debounce).
   */
  debounceMs?: number;
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

function wrapDebouncedDbChanged(
  handler: (data: DbChangedEvent) => void,
  debounceMs: number,
): (data: DbChangedEvent) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPayload: DbChangedEvent | undefined;

  return (data: DbChangedEvent) => {
    lastPayload = data;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (lastPayload !== undefined) {
        handler(lastPayload);
      }
    }, debounceMs);
  };
}

function attachJobEventListeners(
  source: EventSource,
  options: SubscribeJobEventsOptions,
): void {
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

  const debounceMs = options.debounceMs ?? 0;
  const onDbChanged =
    options.onDbChanged &&
    debounceMs > 0 &&
    Number.isFinite(debounceMs)
      ? wrapDebouncedDbChanged(options.onDbChanged, debounceMs)
      : options.onDbChanged;

  source.addEventListener("jobs:db-changed", (ev: MessageEvent) => {
    const data = parseEventData<DbChangedEvent>(ev.data);
    if (data && onDbChanged) {
      onDbChanged(data);
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
}

/**
 * Subscribe to job lifecycle + progress events via Server-Sent Events.
 * Pauses the connection while the preview tab is backgrounded (no reload).
 * Returns an unsubscribe function — call on view teardown.
 */
/** Resolve linked job/db ids from the app's data-sources.json (same origin). */
export async function resolveAppJobEventScope(): Promise<{
  jobIds: string[];
  dbIds: string[];
}> {
  try {
    const res = await fetch("data-sources.json", { cache: "no-store" });
    if (!res.ok) {
      return { jobIds: [], dbIds: [] };
    }
    const json = (await res.json()) as DataSourcesConfig;
    const jobIds = new Set<string>();
    const dbIds = new Set<string>();
    for (const source of json.sources ?? []) {
      if (source.jobId) jobIds.add(source.jobId);
      const db =
        source.databaseId ?? source.dbId ?? source.registryId ?? undefined;
      if (db) dbIds.add(db);
    }
    return { jobIds: [...jobIds], dbIds: [...dbIds] };
  } catch {
    return { jobIds: [], dbIds: [] };
  }
}

/**
 * Subscribe to job/db events scoped to this mini-app's data-sources.json.
 * Pass explicit jobIds/dbIds to narrow further.
 */
export function subscribeJobEventsForApp(
  options: SubscribeJobEventsOptions,
): () => void {
  let cancelled = false;
  let innerUnsub: (() => void) | undefined;

  void (async () => {
    const scope = await resolveAppJobEventScope();
    if (cancelled) return;
    innerUnsub = subscribeJobEvents({
      ...options,
      jobIds: options.jobIds ?? scope.jobIds,
      dbIds: options.dbIds ?? scope.dbIds,
    });
  })();

  return () => {
    cancelled = true;
    innerUnsub?.();
  };
}

export function subscribeJobEvents(
  options: SubscribeJobEventsOptions,
): () => void {
  let source: EventSource | null = new EventSource(
    buildEventsUrl(options.jobIds, options.dbIds),
  );
  attachJobEventListeners(source, options);

  const unregisterPausable = registerPausablePreviewResource({
    pause: () => {
      source?.close();
      source = null;
    },
    resume: () => {
      if (source) {
        return;
      }
      source = new EventSource(buildEventsUrl(options.jobIds, options.dbIds));
      attachJobEventListeners(source, options);
    },
  });

  return () => {
    unregisterPausable();
    source?.close();
    source = null;
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
