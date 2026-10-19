/**
 * Server-Sent Events endpoint for mini-app job subscriptions.
 * Works on desktop gateway and cloud app host (same-origin with iframe).
 *
 * Status delivery:
 * - Push (cloud app host with the Pub/Sub subscriber live): status events arrive
 *   in the hub, stamped with the owning workspace's ownerKey. One status read per
 *   job on connect (baseline + access check + ownerKey), then events only; a slow
 *   safety re-read (default 60s) while a job is running covers a lost event.
 * - Poll (desktop, or push unavailable / older memory without ownerKey): read
 *   every pollIntervalMs, as before.
 *
 * Final answers stop the asking: 401/403 (forbidden) and 404 (job not found) are
 * not retried on the poll timer. A missing job is announced once (jobs:unknown,
 * ignored by older SDKs). With push live it is never re-read — if it is created
 * later its pushed status still arrives, because the owner comes from the page's
 * access (resolveOwnerKey), not from a successful status read. Without push it
 * is re-read every notFoundPollMs.
 */

import type { Express, Request, Response } from "express";
import type { JobEvent, JobStatusChangedData } from "../../core/types/jobEvents.js";
import { jobEventDbId, jobEventJobId } from "../../core/types/jobEvents.js";
import type { JobEventHub } from "./JobEventHub.js";

export interface JobStatusPollResult {
  jobId: string;
  status: string;
  completedAt?: string;
  error?: string;
  lastOutput?: string;
  name?: string;
  /** Owner workspace (opaque, from memory). Required to accept pushed events. */
  ownerKey?: string;
}

export interface JobEventsSseOptions {
  hub: JobEventHub;
  /** Poll remote job status (optional). Receives the SSE request for auth context. */
  pollJobStatus?: (
    jobId: string,
    req: Request,
  ) => Promise<JobStatusPollResult | null>;
  pollIntervalMs?: number;
  /** True while pushed status events are flowing (cloud app host subscriber). */
  pushActive?: () => boolean;
  /** Re-read interval for running jobs when push is active. Default 60s. */
  safetyPollMs?: number;
  /**
   * Owner workspace for this page, from its access check (cloud app host). Lets
   * pushed events reach jobs the status read can't find yet (or ever).
   */
  resolveOwnerKey?: (req: Request) => Promise<string | undefined>;
  /** Re-read interval for a not-found job when push is not active. Default 5 min. */
  notFoundPollMs?: number;
  /** Desktop-only: one-shot Turso pull when client subscribes to dbIds (mini-app SSE). */
  onDbIdsSubscribe?: (dbIds: string[]) => void;
}

const ACTIVE_STATUSES = new Set(["running", "pending", "queued", "starting"]);

interface JobWatch {
  status?: string;
  completedAt?: string;
  ownerKey?: string;
  recordedAt?: string;
  lastPolledAt: number;
  forbidden: boolean;
  /** Last read said the job does not exist (404). */
  notFound: boolean;
  polling: boolean;
}

function parseIdList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function matchesFilter(
  event: JobEvent,
  jobIds: string[],
  dbIds: string[],
): boolean {
  if (jobIds.length === 0 && dbIds.length === 0) {
    return true;
  }

  if (event.type === "jobs:db-changed" && dbIds.length > 0) {
    const dbId = jobEventDbId(event);
    if (dbId !== undefined && dbIds.includes(dbId)) {
      return true;
    }
  }

  const jobId = jobEventJobId(event);
  return jobId !== undefined && jobIds.includes(jobId);
}

function writeSse(res: Response, event: JobEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export function registerJobEventsSseRoutes(
  app: Express,
  options: JobEventsSseOptions,
): void {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const safetyPollMs = options.safetyPollMs ?? 60_000;
  const notFoundPollMs = options.notFoundPollMs ?? 300_000;

  app.get("/api/jobs/events", (req: Request, res: Response) => {
    const jobIds = parseIdList(req.query.jobIds);
    const dbIds = parseIdList(req.query.dbIds);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    if (dbIds.length > 0 && options.onDbIdsSubscribe) {
      options.onDbIdsSubscribe(dbIds);
    }

    const watches = new Map<string, JobWatch>(
      jobIds.map((id) => [id, { lastPolledAt: 0, forbidden: false, notFound: false, polling: false }]),
    );

    const emitStatus = (data: JobStatusChangedData): void => {
      writeSse(res, { type: "jobs:status-changed", data });
    };

    const unsubscribe = options.hub.subscribe((event) => {
      if (!matchesFilter(event, jobIds, dbIds)) {
        return;
      }
      if (event.type !== "jobs:status-changed") {
        writeSse(res, event);
        return;
      }
      const data = event.data as JobStatusChangedData;
      const watch = watches.get(data.jobId);
      if (event.ownerKey !== undefined) {
        // Pushed from memory: only for connections that read this job as the same owner.
        if (!watch || watch.forbidden || !watch.ownerKey || watch.ownerKey !== event.ownerKey) {
          return;
        }
        if (event.recordedAt && watch.recordedAt && event.recordedAt < watch.recordedAt) {
          return; // out-of-order delivery: older than what this tab already has
        }
        if (event.recordedAt) watch.recordedAt = event.recordedAt;
        if (watch.status === data.status && watch.completedAt === data.completedAt) {
          return; // duplicate delivery
        }
      }
      if (watch) {
        watch.status = data.status;
        watch.completedAt = data.completedAt;
      }
      emitStatus(data);
    });

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    if (options.pollJobStatus && jobIds.length > 0) {
      const pollOne = async (jobId: string, watch: JobWatch): Promise<void> => {
        watch.polling = true;
        watch.lastPolledAt = Date.now();
        try {
          const snapshot = await options.pollJobStatus!(jobId, req);
          if (!snapshot) {
            return;
          }
          watch.notFound = false;
          if (snapshot.ownerKey) watch.ownerKey = snapshot.ownerKey;
          if (watch.status === undefined) {
            // Seed baseline without emitting — avoids replaying a stale terminal
            // status (e.g. previous run "failed") when the user starts a new run.
            watch.status = snapshot.status;
            watch.completedAt = snapshot.completedAt;
            return;
          }
          if (watch.status === snapshot.status && watch.completedAt === snapshot.completedAt) {
            return;
          }
          watch.status = snapshot.status;
          watch.completedAt = snapshot.completedAt;
          emitStatus({
            jobId: snapshot.jobId,
            name: snapshot.name,
            status: snapshot.status,
            completedAt: snapshot.completedAt,
            error: snapshot.error,
            lastOutput: snapshot.lastOutput,
          });
        } catch (err) {
          // Access denied for this caller: stop polling it on this connection.
          if ((err as { forbidden?: boolean })?.forbidden) watch.forbidden = true;
          // Job does not exist: a final answer, not "nothing yet". Say so once.
          if ((err as { notFound?: boolean })?.notFound && !watch.notFound) {
            watch.notFound = true;
            res.write(`event: jobs:unknown\ndata: ${JSON.stringify({ jobId })}\n\n`);
          }
        } finally {
          watch.polling = false;
        }
      };

      const isDue = (watch: JobWatch, now: number): boolean => {
        if (watch.forbidden || watch.polling) return false;
        if (watch.lastPolledAt === 0) return true;
        const pushed = Boolean(watch.ownerKey) && options.pushActive?.() === true;
        if (watch.notFound) {
          // Pushed events still arrive if it is created later; only re-read without push.
          return !pushed && now - watch.lastPolledAt >= notFoundPollMs - 50;
        }
        if (!pushed) return now - watch.lastPolledAt >= pollIntervalMs - 50;
        return ACTIVE_STATUSES.has(watch.status ?? "") && now - watch.lastPolledAt >= safetyPollMs;
      };

      const tick = (): void => {
        const now = Date.now();
        for (const [jobId, watch] of watches) {
          if (isDue(watch, now)) void pollOne(jobId, watch);
        }
      };
      const startPolling = (): void => {
        if (closed) return;
        tick();
        pollTimer = setInterval(tick, pollIntervalMs);
      };
      if (options.resolveOwnerKey) {
        // Owner from the page's access: push works from connect, for every job.
        void options
          .resolveOwnerKey(req)
          .then((key) => {
            if (key) for (const watch of watches.values()) watch.ownerKey ??= key;
          })
          .catch(() => undefined)
          .finally(startPolling);
      } else {
        startPolling();
      }
    }

    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 25_000);

    req.on("close", () => {
      closed = true;
      unsubscribe();
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      clearInterval(keepAlive);
    });
  });
}
