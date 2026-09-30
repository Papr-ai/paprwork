/**
 * Pub/Sub fanout after writer commit (Phase 2.4).
 */

import {
  fanoutAppRepoCommitted,
  type AppRepoCommittedEvent,
} from "../syncV3/appRepoCommittedFanout.js";

export type { AppRepoCommittedEvent };

const recentEvents: AppRepoCommittedEvent[] = [];

type PubSubModule = typeof import("@google-cloud/pubsub");
let pubsubModulePromise: Promise<PubSubModule> | null = null;
let pubsubClient: InstanceType<PubSubModule["PubSub"]> | null = null;

async function loadPubSubClient(): Promise<
  InstanceType<PubSubModule["PubSub"]>
> {
  if (pubsubClient) {
    return pubsubClient;
  }
  pubsubModulePromise ??= import("@google-cloud/pubsub");
  const { PubSub } = await pubsubModulePromise;
  pubsubClient = new PubSub();
  return pubsubClient;
}

async function publishToGcpTopic(
  topicName: string,
  event: AppRepoCommittedEvent,
): Promise<void> {
  try {
    const client = await loadPubSubClient();
    const topic = client.topic(topicName);
    await topic.publishMessage({ json: event });
    console.log(
      `[AppRepoWriter] Pub/Sub published appId=${event.appId} commit=${event.commitSha.slice(0, 8)}`,
    );
  } catch (err) {
    console.warn(
      `[AppRepoWriter] Pub/Sub publish failed appId=${event.appId}:`,
      (err as Error).message.slice(0, 160),
    );
  }
}

export async function publishAppRepoCommitted(
  event: AppRepoCommittedEvent,
): Promise<void> {
  recentEvents.push(event);
  while (recentEvents.length > 100) {
    recentEvents.shift();
  }

  const topic = process.env.PAPR_APP_REPO_COMMITTED_TOPIC?.trim();
  if (topic) {
    await publishToGcpTopic(topic, event);
  }

  await fanoutAppRepoCommitted(event);
}

export function listRecentCommittedEventsForTests(): AppRepoCommittedEvent[] {
  return [...recentEvents];
}

export function clearCommittedEventsForTests(): void {
  recentEvents.length = 0;
}
