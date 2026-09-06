/**
 * Cloud scheduler coordination when Sync V3 dispatch is enabled.
 *
 * - local-preferred (default): desktop runs when awake; memory runs when asleep.
 * - cloud-preferred: memory runs always; desktop defers to avoid double-fire.
 * - local-only: desktop only; memory never schedules.
 */

import { loadSettings } from "../services/settingsStore.js";
import { isSyncV3FlagEnabled } from "../services/syncV3/syncV3Flags.js";
import { getPaprApiKey } from "./keyResolver.js";

export {
  isJobDeferredToCloudScheduler,
  shouldDesktopSchedulerRunJob,
} from "../services/jobs/executionCapability.js";

/** Avoid keychain IPC + settings read on every 60s scheduler tick. */
const CLOUD_SCHEDULER_AUTH_CACHE_MS = 120_000;
let cloudSchedulerAuthCache:
  | { value: boolean; expiresAt: number }
  | null = null;

export function clearCloudSchedulerAuthorityCache(): void {
  cloudSchedulerAuthCache = null;
}

/** True when cloud sync + Papr auth + dispatch push are active. */
export async function isCloudSchedulerAuthoritative(): Promise<boolean> {
  const now = Date.now();
  if (cloudSchedulerAuthCache && now < cloudSchedulerAuthCache.expiresAt) {
    return cloudSchedulerAuthCache.value;
  }

  let value = false;
  if (isSyncV3FlagEnabled("SYNC_V3_DISPATCH_PUSH")) {
    const settings = await loadSettings();
    if (settings.preferences.cloudSyncEnabled !== false) {
      const apiKey = await getPaprApiKey();
      value = Boolean(apiKey);
    }
  }

  cloudSchedulerAuthCache = {
    value,
    expiresAt: now + CLOUD_SCHEDULER_AUTH_CACHE_MS,
  };
  return value;
}
