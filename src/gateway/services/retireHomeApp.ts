/**
 * The Home dashboard mini-app is retired: Focus is native in Papr Work. Each boot, take the
 * installed copy off this device (folder to backups/retired-apps). First release its claim on
 * the Focus database (data/databases/home-daily-briefs) so removing the app never tombstones
 * it. Jobs it used to own (Daily Brief, trackers) are re-linked by focusSystemJobs.
 */
import { existsSync } from "fs";
import path from "path";
import { getPaprAppsRoot, isCloudAgentGatewayMode } from "../../core/utils/paprRoot.js";

export const RETIRED_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

/** True when the Home app was found and removed (so the caller re-projects Focus). */
export async function retireHomeApp(): Promise<boolean> {
  // Cloud sandbox: the workspace comes from the cloud repos; never rewrite it there.
  if (isCloudAgentGatewayMode()) return false;
  // Move its jobs (Daily Brief, trackers) to Papr Work first, while the old links still resolve.
  const { ensureFocusSystemJobs } = await import("./focusSystemJobs.js");
  await ensureFocusSystemJobs();
  const { initializeDatabaseRegistry } = await import("./DatabaseRegistryService.js");
  const released = await (await initializeDatabaseRegistry()).releaseSchemaOwner(RETIRED_HOME_APP_ID);
  if (released) console.log(`[RetireHome] Focus database no longer owned by the Home app (${released})`);
  const { getAppService } = await import("./AppService.js");
  const svc = getAppService();
  if (!existsSync(path.join(getPaprAppsRoot(), RETIRED_HOME_APP_ID)) && !(await svc.getApp(RETIRED_HOME_APP_ID))) return false;
  return svc.removeRetiredApp(RETIRED_HOME_APP_ID);
}
