/**
 * Receive job events pushed by the memory server (Pub/Sub) and feed the
 * in-process JobEventHub, so every app host instance can reach its own tabs.
 *
 * Each instance creates its own short-lived subscription on the topic (fanout):
 * Pub/Sub delivers every message to every subscription. Subscriptions are deleted
 * on shutdown and expire on their own (1 day idle) if an instance dies.
 *
 * Config: PAPR_JOB_EVENTS_TOPIC = projects/<project>/topics/<topic>. Unset = off
 * (the SSE route then keeps polling memory, the pre-push behaviour).
 * PUBSUB_EMULATOR_HOST is honoured by the client library for local tests.
 */

import { randomUUID } from "crypto";
import type { JobEvent, JobStatusChangedData, DbChangedData } from "../../../core/types/jobEvents.js";
import type { JobEventHub } from "../JobEventHub.js";
import { publishDbChanged } from "../../utils/publishJobRunEvents.js";

interface PushedEvent {
  type?: string;
  ownerKey?: string;
  recordedAt?: string;
  data?: Record<string, unknown>;
}

export interface JobEventsSubscriberHandle {
  /** True once the subscription is live; SSE switches from polling to push. */
  isActive(): boolean;
  stop(): Promise<void>;
}

const SUBSCRIBE_TIMEOUT_MS = 10_000;

const inactive: JobEventsSubscriberHandle = {
  isActive: () => false,
  stop: async () => undefined,
};

/** Route one pushed message into the hub. Exported for tests. */
export function dispatchPushedJobEvent(hub: JobEventHub, raw: string): boolean {
  let event: PushedEvent;
  try {
    event = JSON.parse(raw) as PushedEvent;
  } catch {
    return false;
  }
  const data = event.data;
  if (!data || typeof data !== "object") return false;

  if (event.type === "jobs:status-changed") {
    if (typeof data.jobId !== "string" || typeof data.status !== "string") return false;
    // ownerKey is required for remote status: the SSE route only forwards it to
    // connections whose access resolved to the same owner.
    if (typeof event.ownerKey !== "string" || !event.ownerKey) return false;
    hub.publish({
      type: "jobs:status-changed",
      data: data as unknown as JobStatusChangedData,
      ownerKey: event.ownerKey,
      ...(event.recordedAt ? { recordedAt: event.recordedAt } : {}),
    } satisfies JobEvent);
    return true;
  }

  if (event.type === "jobs:db-changed") {
    const d = data as unknown as DbChangedData;
    if (!d.jobId && !d.dbId) return false;
    // Same path as POST /internal/db-changed: coalesced per db/job, published on
    // the process-wide hub (getJobEventHub) the SSE route subscribes to.
    publishDbChanged({
      ...(d.jobId ? { jobId: d.jobId } : {}),
      ...(d.dbId ? { dbId: d.dbId } : {}),
      tables: Array.isArray(d.tables) ? d.tables : [],
    });
    return true;
  }
  return false;
}

export async function startJobEventsSubscriber(
  hub: JobEventHub,
  options: { topic?: string; log?: Pick<Console, "log" | "warn"> } = {},
): Promise<JobEventsSubscriberHandle> {
  const log = options.log ?? console;
  const topicPath = (options.topic ?? process.env.PAPR_JOB_EVENTS_TOPIC ?? "").trim();
  const match = /^projects\/([^/]+)\/topics\/([^/]+)$/.exec(topicPath);
  if (!match) {
    if (topicPath) log.warn(`[JobEventsPush] invalid PAPR_JOB_EVENTS_TOPIC "${topicPath}" — polling`);
    return inactive;
  }

  try {
    const { PubSub } = await import("@google-cloud/pubsub");
    const client = new PubSub({ projectId: match[1] });
    const instance = (process.env.K_REVISION ?? "local").replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60);
    const name = `papr-job-events-${instance}-${randomUUID().slice(0, 8)}`;
    // Fail fast (the client's default retry budget is 60s); the host polls meanwhile.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [subscription] = await Promise.race([
      client.topic(topicPath).createSubscription(name, {
        ackDeadlineSeconds: 10,
        messageRetentionDuration: { seconds: 600 },
        expirationPolicy: { ttl: { seconds: 86_400 } },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`subscribe timed out after ${SUBSCRIBE_TIMEOUT_MS}ms`)), SUBSCRIBE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));

    let active = true;
    subscription.on("message", (message) => {
      message.ack(); // best effort: status is re-read on reconnect + safety poll
      dispatchPushedJobEvent(hub, message.data.toString("utf8"));
    });
    // The client library retries transient stream errors itself; "error" means
    // it gave up. Fall back to polling for the rest of this instance's life.
    subscription.on("error", (err: Error) => {
      active = false;
      log.warn("[JobEventsPush] subscription failed — polling:", err.message.slice(0, 160));
    });
    subscription.on("close", () => {
      active = false;
    });
    log.log(`[JobEventsPush] subscribed ${name} to ${topicPath}`);

    return {
      isActive: () => active,
      stop: async () => {
        active = false;
        try {
          await subscription.close();
          await subscription.delete();
        } catch (err) {
          log.warn("[JobEventsPush] cleanup failed (subscription expires on its own):", (err as Error).message.slice(0, 120));
        }
      },
    };
  } catch (err) {
    log.warn("[JobEventsPush] subscribe failed — polling:", (err as Error).message.slice(0, 200));
    return inactive;
  }
}
