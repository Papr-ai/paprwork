/**
 * Loads app data contracts and exposes validation + health checks.
 */

import { promises as fs } from "fs";
import path from "path";
import { existsSync } from "fs";
import { getAppService } from "./AppService.js";
import { getJobsService } from "./JobsService.js";
import { jobBelongsToApp, STANDALONE_APP_ID } from "./jobs/appIds.js";
import type { JobRecord } from "./jobs/types.js";
import {
  type ContractValidationResult,
  type DataContract,
  listUserTablesWithCounts,
  parseDataContract,
  validateDatabaseAgainstContract,
} from "./dataContract.js";
import {
  findStrayDatabaseFiles,
  type StrayDbFile,
} from "./dbPathNormalization.js";

export interface AppDataHealthReport {
  appId: string;
  hasContract: boolean;
  /** warn = log violations only; fail = also mark job failed when contract exists */
  contractEnforcement: "warn" | "fail" | null;
  primary: {
    alias: string | null;
    dbPath: string | null;
    exists: boolean;
  };
  tableCounts: Array<{ table: string; count: number }>;
  contractValidation: ContractValidationResult | null;
  linkedSources: Array<{
    alias: string;
    jobId?: string;
    dbId?: string;
    dbPath: string;
    role?: string;
    exists: boolean;
    tableCount: number;
  }>;
  orphanDbFiles: Array<{ path: string; sizeBytes: number; jobId: string }>;
  /** Stray DB files in app folder or non-canonical job paths (Tier 3). */
  strayDbFiles: StrayDbFile[];
}

export interface ContractValidationOutcome {
  result: ContractValidationResult;
  enforceOnFailure: boolean;
}

let instance: DataContractService | null = null;

export function getDataContractService(): DataContractService {
  if (!instance) {
    instance = new DataContractService();
  }
  return instance;
}

export class DataContractService {
  getContractPath(appId: string): string {
    const appService = getAppService();
    const root = appService.getAppsRootPath();
    return path.join(root, appId, "data-contract.json");
  }

  async readContract(appId: string): Promise<DataContract | null> {
    const contractPath = this.getContractPath(appId);
    try {
      const raw = await fs.readFile(contractPath, "utf8");
      return parseDataContract(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async validateJob(job: JobRecord): Promise<{
    result: ContractValidationResult;
    enforceOnFailure: boolean;
  } | null> {
    const appId = (job.appIds ?? []).find((id) => id !== STANDALONE_APP_ID);
    if (!appId) return null;

    const contract = await this.readContract(appId);
    if (!contract) return null;

    const appService = getAppService();
    await appService.initialize();
    const primary = await appService.getPrimaryDataSource(appId);
    if (!primary?.dbPath) {
      return {
        enforceOnFailure: contract.enforceOnFailure === true,
        result: {
          passed: false,
          violations: [
            {
              severity: "error",
              message: `No primary data source linked for app ${appId}`,
            },
          ],
          summary: "No primary data source",
          tablesChecked: [],
        },
      };
    }

    return {
      enforceOnFailure: contract.enforceOnFailure === true,
      result: await validateDatabaseAgainstContract(
        {
          dbPath: primary.dbPath,
          dbId: primary.dbId,
          alias: primary.alias,
        },
        contract,
        {
          jobId: job.id,
          jobName: job.name,
        },
      ),
    };
  }

  async getDataHealth(appId: string): Promise<AppDataHealthReport> {
    const appService = getAppService();
    await appService.initialize();
    const jobsService = getJobsService();
    await jobsService.initialize();

    const app = await appService.getApp(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    const contract = await this.readContract(appId);
    const config = await appService.getDataSourcesConfig(appId);
    const primary = await appService.getPrimaryDataSource(appId);
    const primaryPath = primary?.dbPath ?? null;

    const tableCounts = primaryPath
      ? await listUserTablesWithCounts({
          dbPath: primaryPath,
          dbId: primary?.dbId,
          alias: primary?.alias,
        })
      : [];

    const contractValidation =
      contract && primaryPath
        ? await validateDatabaseAgainstContract(
            {
              dbPath: primaryPath,
              dbId: primary?.dbId,
              alias: primary?.alias,
            },
            contract,
          )
        : null;

    const linkedSources = await Promise.all(
      config.sources.map(async (source) => {
        const exists = existsSync(source.dbPath);
        const counts = exists
          ? await listUserTablesWithCounts({
              dbPath: source.dbPath,
              dbId: source.dbId,
              alias: source.alias,
            })
          : [];
        return {
          alias: source.alias,
          ...(source.jobId ? { jobId: source.jobId } : {}),
          ...(source.dbId ? { dbId: source.dbId } : {}),
          dbPath: source.dbPath,
          role: source.role,
          exists,
          tableCount: counts.length,
        };
      }),
    );

    const orphanDbFiles: AppDataHealthReport["orphanDbFiles"] = [];
    const linkedJobIds = new Set(
      config.sources
        .map((s) => s.jobId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    for (const job of await jobsService.listJobs()) {
      if (!jobBelongsToApp(job.appIds, appId) && !linkedJobIds.has(job.id)) {
        continue;
      }
      const jobDir = await jobsService.getJobPath(job.id);
      if (!jobDir) continue;

      const candidates = [
        path.join(jobDir, "data", "data.db"),
        path.join(jobDir, "audit.db"),
        path.join(jobDir, "data.db"),
      ];
      const canonical = path.join(jobDir, "data", "data.db");
      for (const candidate of candidates) {
        if (!existsSync(candidate) || candidate === primaryPath) continue;
        if (candidate === canonical && primaryPath === canonical) continue;
        try {
          const stat = await fs.stat(candidate);
          if (stat.size === 0) continue;
          orphanDbFiles.push({
            path: candidate,
            sizeBytes: stat.size,
            jobId: job.id,
          });
        } catch {
          // skip
        }
      }
    }

    const strayDbFiles = await findStrayDatabaseFiles(
      appId,
      config,
      primaryPath,
    );

    return {
      appId,
      hasContract: contract !== null,
      contractEnforcement: contract
        ? contract.enforceOnFailure === true
          ? "fail"
          : "warn"
        : null,
      primary: {
        alias: primary?.alias ?? null,
        dbPath: primaryPath,
        exists: primaryPath ? existsSync(primaryPath) : false,
      },
      tableCounts,
      contractValidation,
      linkedSources,
      orphanDbFiles,
      strayDbFiles,
    };
  }
}
