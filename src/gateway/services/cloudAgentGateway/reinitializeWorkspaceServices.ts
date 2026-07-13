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
}
