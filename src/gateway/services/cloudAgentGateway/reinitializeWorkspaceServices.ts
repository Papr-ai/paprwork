/**
 * Reset Papr workspace singletons after PAPR_HOME changes (cloud agent gateway per-run clone
 * or desktop org/namespace switch).
 */

import { reinitializeWorkspaceServices } from "../workspaceSwitchService.js";

export async function reinitializeWorkspaceServicesForCloudRun(input: {
  paprApiKey: string;
}): Promise<void> {
  await reinitializeWorkspaceServices({ paprApiKey: input.paprApiKey });
}
