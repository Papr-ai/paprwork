import { createHash, randomUUID } from "crypto";

/** Stable 12-char id for a scheduled slot (matches gateway sandbox suffix when lease omits runId). */
export function deriveScheduledCloudRunId(
  jobId: string,
  scheduledDueAt: string,
): string {
  return createHash("sha256")
    .update(`${jobId}:${scheduledDueAt}`)
    .digest("hex")
    .slice(0, 12);
}

export function resolveCloudAgentRunId(input: {
  jobId: string;
  runId?: string;
  scheduledDueAt?: string;
}): string {
  const explicit = input.runId?.trim();
  if (explicit) {
    return explicit;
  }
  const dueAt = input.scheduledDueAt?.trim();
  if (dueAt) {
    return deriveScheduledCloudRunId(input.jobId, dueAt);
  }
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function newCloudAgentRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
