/**
 * Inject JOB_DB / PAPR_DB_* env vars for cloud agent runs (mirrors CommandJobExecutor).
 */

import {
  jobWriteDatabaseEnv,
  resolveJobWriteTargets,
} from "../jobAppDatabase.js";
import { getJobsService, initializeJobsService } from "../JobsService.js";
import { STANDALONE_APP_ID } from "../jobs/appIds.js";
import {
  tursoCredsByDbIdFromCloudSources,
  shouldUseCloudSandboxTursoDirect,
} from "./cloudSandboxTursoDirect.js";
import type { CloudTursoSource } from "./types.js";

export interface PrepareCloudJobEnvironmentInput {
  jobId: string;
  userId?: string;
  tursoSources?: CloudTursoSource[];
}

export async function prepareCloudJobEnvironment(
  input: string | PrepareCloudJobEnvironmentInput,
): Promise<void> {
  const jobId = typeof input === "string" ? input : input.jobId;
  const userId = typeof input === "string" ? undefined : input.userId;
  const tursoSources =
    typeof input === "string" ? undefined : input.tursoSources;

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

  const writeTargets = await resolveJobWriteTargets(job, {
    actingUserId: userId,
    tursoCredsByDbId: tursoCredsByDbIdFromCloudSources(tursoSources),
  });
  const linkedAppId = (job.appIds ?? []).find((id) => id !== STANDALONE_APP_ID);
  if (writeTargets.length > 0) {
    Object.assign(process.env, jobWriteDatabaseEnv(writeTargets, linkedAppId));
    if (shouldUseCloudSandboxTursoDirect()) {
      console.log(
        `[CloudAgentRun] Turso direct env for job ${jobId}: ` +
          `${writeTargets.map((t) => t.dbId).join(", ")}`,
      );
    }
  } else {
    delete process.env.APP_DB;
    delete process.env.APP_DB_ALIAS;
    delete process.env.APP_DB_ID;
    delete process.env.PAPR_WRITE_DB_IDS;
    delete process.env.PAPR_DB_MODE;
    delete process.env.PAPR_DB_URL;
    delete process.env.PAPR_DB_AUTH_TOKEN;
  }
}
