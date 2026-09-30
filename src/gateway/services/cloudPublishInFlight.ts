/**
 * Serialize memory publish POSTs per appId to avoid catalog/sharing/register races.
 */

const inFlightByAppId = new Map<string, Promise<unknown>>();

export async function withPublishInFlight<T>(
  appId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = inFlightByAppId.get(appId);
  if (prior) {
    await prior.catch(() => undefined);
  }

  const task = operation();
  inFlightByAppId.set(appId, task);
  try {
    return await task;
  } finally {
    if (inFlightByAppId.get(appId) === task) {
      inFlightByAppId.delete(appId);
    }
  }
}

/** Test helper — reset module state. */
export function resetPublishInFlightForTests(): void {
  inFlightByAppId.clear();
}
