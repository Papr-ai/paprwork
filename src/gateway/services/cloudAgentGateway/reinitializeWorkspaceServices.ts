/**
 * Reset Papr workspace singletons after PAPR_HOME changes (cloud agent gateway per-run clone).
 */

import {
  initializeAppService,
  resetAppServiceSingletonForTests,
} from "../AppService.js";
import {
  initializeJobsService,
  resetJobsServiceSingletonForTests,
} from "../JobsService.js";
import {
  initializeAgentService,
  resetAgentServiceSingletonForTests,
} from "../AgentService.js";
import { refreshToolResultTruncationSettings } from "../agent/toolResultTruncationSettings.js";

export async function reinitializeWorkspaceServicesForCloudRun(input: {
  paprApiKey: string;
}): Promise<void> {
  resetJobsServiceSingletonForTests();
  resetAppServiceSingletonForTests();
  resetAgentServiceSingletonForTests();

  await initializeAppService();
  await initializeJobsService();
  await initializeAgentService({
    mode: "local",
    paprApiKey: input.paprApiKey,
    openaiApiKey: undefined,
  });

  const truncationSettings = await refreshToolResultTruncationSettings();
  console.log(
    `[CloudAgentGateway] Tool truncation settings loaded from ${process.env.PAPR_HOME ?? "Papr"}/data/settings.json` +
      (truncationSettings.disableAllTruncation ? " (truncation disabled)" : ""),
  );
}
