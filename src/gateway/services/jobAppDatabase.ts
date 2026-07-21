/**
 * Resolves APP_DB for jobs linked to mini-apps.
 */

import { getAppService } from "./AppService.js";
import { STANDALONE_APP_ID } from "./jobs/appIds.js";

/** Apps created before this instant are legacy (no primary required at job launch). */
export const LEGACY_APP_PRIMARY_CUTOFF_ISO = "2026-07-16T00:00:00.000Z";

const LEGACY_APP_PRIMARY_CUTOFF_MS = Date.parse(LEGACY_APP_PRIMARY_CUTOFF_ISO);

export function isLegacyApp(createdAt: string): boolean {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) {
    return false;
  }
  return createdMs < LEGACY_APP_PRIMARY_CUTOFF_MS;
}

export interface JobAppDatabaseContext {
  appId: string;
  appDb: string;
  appDbAlias: string;
}

export async function resolveJobAppDatabase(
  appIds: readonly string[] | undefined,
): Promise<JobAppDatabaseContext | null> {
  const linkedAppIds = (appIds ?? []).filter((id) => id !== STANDALONE_APP_ID);
  if (linkedAppIds.length === 0) return null;

  const appService = getAppService();
  await appService.initialize();

  const appId = linkedAppIds[0];
  const primary = await appService.getPrimaryDataSource(appId);
  if (!primary) return null;

  return {
    appId,
    appDb: primary.dbPath,
    appDbAlias: primary.alias,
  };
}

export async function requireJobAppDatabase(
  appIds: readonly string[] | undefined,
): Promise<JobAppDatabaseContext | null> {
  const linkedAppIds = (appIds ?? []).filter((id) => id !== STANDALONE_APP_ID);
  if (linkedAppIds.length === 0) return null;

  const resolved = await resolveJobAppDatabase(linkedAppIds);
  if (resolved) return resolved;

  const appId = linkedAppIds[0];
  const appService = getAppService();
  await appService.initialize();
  const app = await appService.getApp(appId);

  if (app && isLegacyApp(app.createdAt)) {
    console.warn(
      `[jobAppDatabase] Legacy app ${appId} (${app.title}) has no primary database; ` +
        "skipping APP_DB injection. Set primary via link_app_data_source({ setPrimary: true }) for new jobs.",
    );
    return null;
  }

  throw new Error(
    `App-linked job cannot start because app ${appId} has no primary database. ` +
      "Attach a primary data source before running the job; do not fall back to JOB_DB or a hardcoded path.",
  );
}

export function jobAppDatabaseEnv(
  ctx: JobAppDatabaseContext,
): Record<string, string> {
  return {
    APP_ID: ctx.appId,
    APP_DB: ctx.appDb,
    APP_DB_ALIAS: ctx.appDbAlias,
  };
}

export function jobAppDatabasePromptLines(ctx: JobAppDatabaseContext): string[] {
  return [
    `APP_ID="${ctx.appId}"`,
    `APP_DB="${ctx.appDb}"`,
    `APP_DB_ALIAS="${ctx.appDbAlias}"`,
    "",
    "Use APP_DB for all mini-app-facing reads/writes (tables the UI displays).",
    "Use JOB_DB only for job-local scratch (job_runs, checkpoints, temp tables).",
  ];
}
