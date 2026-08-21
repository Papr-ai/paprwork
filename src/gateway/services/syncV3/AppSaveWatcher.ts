/**
 * App save → writer ops dirty signal (Sync V3).
 */

export function isWriterOpsSavePathEnabled(): boolean {
  return true;
}

export async function notifyAppSaveForWriterOps(
  appId: string,
  scheduleAutoFlush: (appId: string) => void,
): Promise<boolean> {
  scheduleAutoFlush(appId);
  return true;
}
