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

/** True when cloud sync + Papr auth + dispatch push are active. */
export async function isCloudSchedulerAuthoritative(): Promise<boolean> {
  if (!isSyncV3FlagEnabled("SYNC_V3_DISPATCH_PUSH")) {
    return false;
  }
  const settings = await loadSettings();
  if (settings.preferences.cloudSyncEnabled === false) {
    return false;
  }
  const apiKey = await getPaprApiKey();
  return Boolean(apiKey);
}
