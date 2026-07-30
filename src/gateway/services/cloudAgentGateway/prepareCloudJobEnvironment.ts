/**
 * Inject JOB_DB / PAPR_DB_* env vars for cloud agent runs (mirrors CommandJobExecutor).
 */

import {
  jobWriteDatabaseEnv,
  resolveJobWriteTargets,
} from "../jobAppDatabase.js";
import { getJobsService, initializeJobsService } from "../JobsService.js";
import { STANDALONE_APP_ID } from "../jobs/appIds.js";

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

  const writeTargets = await resolveJobWriteTargets(job);
  const linkedAppId = (job.appIds ?? []).find((id) => id !== STANDALONE_APP_ID);
  if (writeTargets.length > 0) {
    Object.assign(process.env, jobWriteDatabaseEnv(writeTargets, linkedAppId));
  } else {
    delete process.env.APP_DB;
    delete process.env.APP_DB_ALIAS;
    delete process.env.APP_DB_ID;
    delete process.env.PAPR_WRITE_DB_IDS;
  }
}
