/**
 * Server-Sent Events endpoint for mini-app job subscriptions.
 * Works on desktop gateway and cloud app host (same-origin with iframe).
 */

import type { Express, Request, Response } from "express";
import type { JobEvent } from "../../core/types/jobEvents.js";
import { jobEventDbId, jobEventJobId } from "../../core/types/jobEvents.js";
import type { JobEventHub } from "./JobEventHub.js";

export interface JobStatusPollResult {
  jobId: string;
  status: string;
  completedAt?: string;
  error?: string;
  lastOutput?: string;
  name?: string;
}

export interface JobEventsSseOptions {
  hub: JobEventHub;
  /** Poll remote job status (optional). Receives the SSE request for auth context. */
  pollJobStatus?: (
    jobId: string,
    req: Request,
  ) => Promise<JobStatusPollResult | null>;
  pollIntervalMs?: number;
  /** Desktop-only: one-shot Turso pull when client subscribes to dbIds (mini-app SSE). */
  onDbIdsSubscribe?: (dbIds: string[]) => void;
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

    const unsubscribe = options.hub.subscribe((event) => {
      if (!matchesFilter(event, jobIds, dbIds)) {
        return;
      }
      writeSse(res, event);
    });

    const lastPolledStatus = new Map<string, string>();
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    if (options.pollJobStatus && jobIds.length > 0) {
      const poll = async (): Promise<void> => {
        for (const jobId of jobIds) {
          try {
            const snapshot = await options.pollJobStatus!(jobId, req);
            if (!snapshot) {
              continue;
            }
            const prev = lastPolledStatus.get(jobId);
            if (prev === undefined) {
              // Seed baseline without emitting — avoids replaying a stale terminal
              // status (e.g. previous run "failed") when the user starts a new run.
              lastPolledStatus.set(jobId, snapshot.status);
              continue;
            }
            if (prev === snapshot.status) {
              continue;
            }
            lastPolledStatus.set(jobId, snapshot.status);
            writeSse(res, {
              type: "jobs:status-changed",
              data: {
                jobId: snapshot.jobId,
                name: snapshot.name,
                status: snapshot.status,
                completedAt: snapshot.completedAt,
                error: snapshot.error,
                lastOutput: snapshot.lastOutput,
              },
            });
          } catch {
            /* non-fatal poll failure */
          }
        }
      };
      void poll();
      pollTimer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
    }

    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 25_000);

    req.on("close", () => {
      unsubscribe();
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      clearInterval(keepAlive);
    });
  });
}
