/**
 * Global preference for automatic cloud mini-app publishing (default ON).
 */

import * as fs from "fs";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import * as path from "path";

export function defaultCloudSettingsPath(): string {
  return path.join(getPaprDataDir(), "settings.json");
}

function readAutoPublishDisabled(settingsPath: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      preferences?: { cloudAutoPublishEnabled?: boolean };
    };
    return data?.preferences?.cloudAutoPublishEnabled === false;
  } catch {
    return false;
  }
}

/** Whether auto cloud publish is enabled globally (users opt out via Settings). */
export function isCloudAutoPublishGloballyEnabled(
  settingsPath: string = defaultCloudSettingsPath(),
): boolean {
  if (process.env.CLOUD_AUTO_PUBLISH_ENABLED === "false") {
    return false;
  }
  return !readAutoPublishDisabled(settingsPath);
}
