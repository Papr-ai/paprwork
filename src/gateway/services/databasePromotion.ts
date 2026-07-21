/**
 * Promote job-colocated data.db files to independent registry databases.
 *
 * App-facing data lives at ~/Papr/data/databases/{slug}/data.db.
 * Job scratch stays at ~/Papr/Jobs/{jobId}/data/data.db (baseline tables only).
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprDataDir, getPaprJobsRoot } from "../../core/utils/paprRoot.js";
import {
  dbIdFromPath,
  initializeDatabaseRegistry,
  normalizeDbPath,
  type DatabaseRecord,
} from "./DatabaseRegistryService.js";
import { dbTursoDatabaseName } from "./tursoDatabaseNaming.js";
import { JobDatabase } from "./jobs/JobDatabase.js";

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "database";
}

export function isJobOwnedDatabasePath(dbPath: string): boolean {
  const jobsRoot = `${path.normalize(getPaprJobsRoot())}${path.sep}`;
  return normalizeDbPath(dbPath).startsWith(jobsRoot);
}

export interface PromoteDatabaseResult {
  dbPath: string;
  dbId: string;
  promoted: boolean;
  record: DatabaseRecord;
}

async function resolveIndependentTargetPath(label: string): Promise<string> {
  const slug = slugifyName(label);
  let targetDir = path.join(getPaprDataDir(), "databases", slug);
  let targetPath = path.join(targetDir, "data.db");
  let counter = 0;

  while (fs.existsSync(targetPath)) {
    counter += 1;
    targetDir = path.join(getPaprDataDir(), "databases", `${slug}-${counter}`);
    targetPath = path.join(targetDir, "data.db");
  }

  return targetPath;
}

/**
 * Move or copy a job-colocated database into the registry. Idempotent when
 * source is already under ~/Papr/data/databases/.
 */
export async function promoteJobDatabaseToRegistry(options: {
  sourcePath: string;
  label: string;
  /** When true, move app data out of the job folder and recreate JOB_DB scratch. */
  moveFromJobFolder?: boolean;
  jobDirForScratchReset?: string;
}): Promise<PromoteDatabaseResult> {
  const normalizedSource = normalizeDbPath(options.sourcePath);
  const registry = await initializeDatabaseRegistry();

  if (!isJobOwnedDatabasePath(normalizedSource)) {
    const record = await registry.ensureForPath(normalizedSource, {
      label: options.label,
    });
    return {
      dbPath: record.localPath,
      dbId: record.dbId,
      promoted: false,
      record,
    };
  }

  const existingAtSource = registry.getByPath(normalizedSource);
  if (
    existingAtSource &&
    !isJobOwnedDatabasePath(existingAtSource.localPath)
  ) {
    return {
      dbPath: existingAtSource.localPath,
      dbId: existingAtSource.dbId,
      promoted: false,
      record: existingAtSource,
    };
  }

  const targetPath = await resolveIndependentTargetPath(options.label);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  const sourceExists = fs.existsSync(normalizedSource);
  if (sourceExists) {
    if (options.moveFromJobFolder) {
      await fs.promises.rename(normalizedSource, targetPath);
      if (options.jobDirForScratchReset) {
        const jobDatabase = new JobDatabase();
        await jobDatabase.ensureDatabase(options.jobDirForScratchReset);
      }
    } else {
      await fs.promises.copyFile(normalizedSource, targetPath);
    }
  } else {
    await fs.promises.writeFile(targetPath, "");
  }

  const dbId = dbIdFromPath(targetPath);
  const record = await registry.register({
    dbId,
    localPath: targetPath,
    label: options.label,
    tursoShortName: dbTursoDatabaseName(dbId),
  });

  return {
    dbPath: targetPath,
    dbId: record.dbId,
    promoted: true,
    record,
  };
}

/**
 * Before deleting a job, ensure any app still pointing at the job-colocated DB
 * is repointed to an independent registry copy.
 */
export async function preserveJobLinkedDatabasesBeforeDelete(
  jobId: string,
): Promise<void> {
  const { getPaprAppsRoot, getPaprJobsRoot } = await import(
    "../../core/utils/paprRoot.js"
  );
  const { getJobsService } = await import("./JobsService.js");
  const {
    parseDataSourcesFile,
    serializeDataSourcesFile,
  } = await import("./appDataSources.js");

  const jobsService = getJobsService();
  await jobsService.initialize();
  const job = await jobsService.getJob(jobId);
  if (!job) {
    return;
  }

  const jobDir = path.join(getPaprJobsRoot(), jobId);

  const appsRoot = getPaprAppsRoot();
  if (!fs.existsSync(appsRoot)) {
    return;
  }

  const entries = await fs.promises.readdir(appsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configPath = path.join(appsRoot, entry.name, "data-sources.json");
    let raw: string;
    try {
      raw = await fs.promises.readFile(configPath, "utf8");
    } catch {
      continue;
    }

    let config;
    try {
      config = parseDataSourcesFile(raw);
    } catch {
      continue;
    }

    let changed = false;
    const nextSources = await Promise.all(
      config.sources.map(async (source) => {
        if (source.jobId !== jobId) {
          return source;
        }

        let dbPath = source.dbPath;
        let dbId = source.dbId;
        if (!isJobOwnedDatabasePath(dbPath)) {
          return source;
        }

        const promoted = await promoteJobDatabaseToRegistry({
          sourcePath: dbPath,
          label: source.alias || job.name,
          moveFromJobFolder: true,
          jobDirForScratchReset: jobDir,
        });
        dbPath = promoted.dbPath;
        dbId = promoted.dbId;

        changed = true;
        return {
          ...source,
          dbPath,
          dbId,
        };
      }),
    );

    if (changed) {
      await fs.promises.writeFile(
        configPath,
        serializeDataSourcesFile({
          primary: config.primary,
          sources: nextSources,
        }),
        "utf8",
      );
      console.log(
        `[databasePromotion] Preserved app ${entry.name} database before job ${jobId} delete`,
      );
    }
  }
}
