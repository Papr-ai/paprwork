import type { TursoPushTrigger } from "../tursoPushScheduler.js";
import { isInteractiveHotPathBusy } from "../gatewayInteractivePriority.js";

/** Manual / user-initiated pushes may run during app load. */
export async function shouldDeferReplicaPushWhileInteractive(
  trigger: TursoPushTrigger,
): Promise<boolean> {
  if (trigger === "manual") {
    return false;
  }
  if (process.env.TURSO_PUSH_DEFER_WHILE_INTERACTIVE === "false") {
    return false;
  }
  return isInteractiveHotPathBusy();
}
