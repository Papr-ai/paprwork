/**
 * Inject JOB_DB / APP_DB env vars for cloud agent runs (mirrors AgentJobExecutor).
 */

import {
  jobAppDatabaseEnv,
  requireJobAppDatabase,
} from "../jobAppDatabase.js";
import { getJobsService, initializeJobsService } from "../JobsService.js";

export async function prepareCloudJobEnvironment(jobId: string): Promise<void> {
  await initializeJobsService();
  const jobsService = getJobsService();
  const job = await jobsService.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found in cloned workspace: ${jobId}`);
  }

  const jobPath = await jobsService.getJobPath(jobId);
  if (jobPath) {
    process.env.JOB_DIR = jobPath;
    const dbPath = await jobsService.getJobDatabasePath(jobId);
    if (dbPath) {
      process.env.JOB_DB = dbPath;
    }
  }

  const appDb = await requireJobAppDatabase(job.appIds);
  if (appDb) {
    Object.assign(process.env, jobAppDatabaseEnv(appDb));
  }
}
