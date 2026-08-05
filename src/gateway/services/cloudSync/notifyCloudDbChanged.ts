/**
 * Notify apps.papr.ai to emit jobs:db-changed SSE after Turso updates from cloud agent runs.
 * Desktop uses in-process JobEventHub via TursoLinkedDbWatcher; cloud agent runs on a
 * separate Cloud Run service and must call Cloud App Host over HTTP.
 */

export interface NotifyCloudDbChangedInput {
  jobId?: string;
  dbId?: string;
  tables?: string[];
}

export async function notifyCloudDbChanged(
  input: NotifyCloudDbChangedInput,
): Promise<void> {
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  if (!hostKey) {
    return;
  }
  if (!input.jobId && !input.dbId) {
    return;
  }

  const host =
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ?? "https://apps.papr.ai";

  try {
    const response = await fetch(`${host}/internal/db-changed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-App-Host-Key": hostKey,
      },
      body: JSON.stringify({
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.dbId ? { dbId: input.dbId } : {}),
        tables: input.tables ?? [],
      }),
    });
    if (!response.ok) {
      console.warn(
        `[CloudAgentRun] db-changed notify failed (${response.status}) for ` +
          `${input.dbId ?? input.jobId ?? "unknown"}`,
      );
    }
  } catch (error) {
    console.warn(
      `[CloudAgentRun] db-changed notify error for ${input.dbId ?? input.jobId ?? "unknown"}:`,
      (error as Error).message.slice(0, 120),
    );
  }
}
