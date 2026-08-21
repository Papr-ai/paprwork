/**
 * Inbound app-repo-committed events (Pub/Sub push, webhook, or direct JSON).
 */

import {
  fanoutAppRepoCommitted,
  type AppRepoCommittedEvent,
} from "./appRepoCommittedFanout.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAppRepoCommittedEvent(
  value: unknown,
): value is AppRepoCommittedEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    isNonEmptyString(event.appId) &&
    isNonEmptyString(event.commitSha) &&
    isNonEmptyString(event.githubOrg) &&
    isNonEmptyString(event.repoName) &&
    isNonEmptyString(event.namespaceId) &&
    isNonEmptyString(event.committedAt)
  );
}

/** Parse direct JSON body or GCP Pub/Sub push envelope. */
export function parseAppRepoCommittedPayload(
  body: unknown,
): AppRepoCommittedEvent | null {
  if (isAppRepoCommittedEvent(body)) {
    return body;
  }

  if (typeof body !== "object" || body === null || !("message" in body)) {
    return null;
  }

  const envelope = body as { message?: { data?: string } };
  const data = envelope.message?.data;
  if (!data) {
    return null;
  }

  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return isAppRepoCommittedEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Accept event from any delivery path; fanout handles dedup + subscribers. */
export async function ingestAppRepoCommittedEvent(
  event: AppRepoCommittedEvent,
): Promise<void> {
  await fanoutAppRepoCommitted(event);
}
