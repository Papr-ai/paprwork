/**
 * Publish reconciliation, cross-app dependency detection, and install health checks
 * for cloud/community mini-apps.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  CloudAppDependenciesFile,
  CloudAppDependencyRef,
  CloudDatabaseDependencyRef,
  CloudInstallHealthReport,
  PublishReconcileReport,
} from "../../core/types/cloudAppDependencies.js";
import { CLOUD_APP_DEPENDENCIES_FILENAME } from "../../core/types/cloudAppDependencies.js";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
  type AppDataSource,
} from "./appDataSources.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";
import type { JobRecord } from "./JobsService.js";
import { DATABASES_REGISTRY_FILENAME, type DatabasesRegistryFile } from "./DatabaseRegistryService.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listBundledAppJobIds(appDir: string): Promise<string[]> {
  const jobsDir = path.join(appDir, "jobs");
  try {
    const entries = await fs.readdir(jobsDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) {
        continue;
      }
      const jobJsonPath = path.join(jobsDir, entry.name, "job.json");
      try {
        await fs.access(jobJsonPath);
        ids.push(entry.name);
      } catch {
        /* skip */
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

async function readAppsIndexTitles(
  paprDir: string,
): Promise<Map<string, { title: string; slug?: string }>> {
  const indexPath = path.join(paprDir, "data", "apps.json");
  const titles = new Map<string, { title: string; slug?: string }>();
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as
      | Array<{ id: string; title?: string; slug?: string }>
      | { apps?: Array<{ id: string; title?: string; slug?: string }> };
    const apps = Array.isArray(parsed) ? parsed : (parsed.apps ?? []);
    for (const app of apps) {
      if (app.id) {
        titles.set(app.id, {
          title: app.title?.trim() || app.id,
          slug: app.slug?.trim() || undefined,
        });
      }
    }
  } catch {
    /* no index */
  }
  return titles;
}

async function readDatabasesRegistry(
  paprDir: string,
): Promise<DatabasesRegistryFile> {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    return JSON.parse(raw) as DatabasesRegistryFile;
  } catch {
    return { version: 1, databases: {} };
  }
}

function jobExistsOnDisk(paprDir: string, jobId: string): boolean {
  return existsSync(path.join(paprDir, "Jobs", jobId, "job.json"));
}

/** Canonical job IDs present in Jobs/ or bundled under apps/{id}/jobs/. */
export async function collectCanonicalAppJobIds(
  paprDir: string,
  appId: string,
): Promise<string[]> {
  const appDir = path.join(paprDir, "apps", appId);
  const bundled = await listBundledAppJobIds(appDir);
  const fromResolver = resolveAppDependentJobIds(paprDir, appId).filter((jobId) =>
    jobExistsOnDisk(paprDir, jobId),
  );
  return [...new Set([...bundled, ...fromResolver])].sort();
}

/** Sync data-sources.json with jobs/dbs that actually exist for this app. */
export async function reconcileAppDataSourcesForPublish(
  paprDir: string,
  appId: string,
  options?: { dryRun?: boolean },
): Promise<PublishReconcileReport> {
  const appDir = path.join(paprDir, "apps", appId);
  const dsPath = path.join(appDir, "data-sources.json");
  const report: PublishReconcileReport = {
    changed: false,
    removedJobIds: [],
    removedDbIds: [],
    addedJobIds: [],
    warnings: [],
  };

  let config;
  try {
    const raw = await fs.readFile(dsPath, "utf8");
    config = parseDataSourcesFile(raw);
  } catch {
    return report;
  }

  const canonicalJobIds = new Set(await collectCanonicalAppJobIds(paprDir, appId));
  const registry = await readDatabasesRegistry(paprDir);
  const knownDbIds = new Set(
    Object.keys(registry.databases).filter(
      (dbId) => registry.databases[dbId]?.status !== "tombstone",
    ),
  );

  const keptSources: AppDataSource[] = [];
  const seenJobIds = new Set<string>();

  for (const source of config.sources) {
    if (source.jobId) {
      if (!canonicalJobIds.has(source.jobId)) {
        report.removedJobIds.push(source.jobId);
        report.changed = true;
        report.warnings.push(
          `Removed stale job reference ${source.jobId} from data-sources (${source.alias})`,
        );
        continue;
      }
      seenJobIds.add(source.jobId);
    }
    if (source.dbId && !knownDbIds.has(source.dbId)) {
      const owner = registry.databases[source.dbId]?.schemaOwnerAppId;
      if (owner && owner !== appId) {
        keptSources.push(source);
        continue;
      }
      report.removedDbIds.push(source.dbId);
      report.changed = true;
      report.warnings.push(
        `Removed missing database ${source.dbId} from data-sources (${source.alias})`,
      );
      continue;
    }
    keptSources.push(source);
  }

  for (const jobId of canonicalJobIds) {
    if (seenJobIds.has(jobId)) {
      continue;
    }
    keptSources.push({
      id: jobId.slice(0, 8),
      type: "sqlite",
      jobId,
      alias: jobId.slice(0, 8),
      dbPath: "",
      tables: [],
      linkedAt: new Date().toISOString(),
    });
    report.addedJobIds.push(jobId);
    report.changed = true;
    report.warnings.push(`Added bundled job ${jobId} to data-sources`);
  }

  if (report.changed && options?.dryRun !== true) {
    await fs.writeFile(
      dsPath,
      serializeDataSourcesFile({ ...config, sources: keptSources }),
      "utf8",
    );
  }

  return report;
}

export async function detectCrossAppDependencies(
  paprDir: string,
  appId: string,
): Promise<CloudAppDependenciesFile> {
  const appDir = path.join(paprDir, "apps", appId);
  const dsPath = path.join(appDir, "data-sources.json");
  const registry = await readDatabasesRegistry(paprDir);
  const appTitles = await readAppsIndexTitles(paprDir);

  const appDeps = new Map<string, CloudAppDependencyRef>();
  const dbDeps: CloudDatabaseDependencyRef[] = [];

  let sources: AppDataSource[] = [];
  try {
    const raw = await fs.readFile(dsPath, "utf8");
    sources = parseDataSourcesFile(raw).sources;
  } catch {
    sources = [];
  }

  for (const source of sources) {
    const dbId = source.dbId?.trim();
    if (!dbId) {
      continue;
    }
    const record = registry.databases[dbId];
    const ownerAppId = record?.schemaOwnerAppId?.trim();
    if (!ownerAppId || ownerAppId === appId) {
      continue;
    }
    const ownerMeta = appTitles.get(ownerAppId);
    dbDeps.push({
      dbId,
      alias: source.alias,
      ownerAppId,
      ownerTitle: ownerMeta?.title,
      ownerSlug: ownerMeta?.slug,
      required: false,
      enables: [`Database alias "${source.alias}"`],
    });
    if (!appDeps.has(ownerAppId)) {
      appDeps.set(ownerAppId, {
        appId: ownerAppId,
        title: ownerMeta?.title,
        slug: ownerMeta?.slug,
        required: false,
        enables: [`Shared database "${source.alias}"`],
      });
    }
  }

  return {
    schemaVersion: "1.0.0",
    updatedAt: new Date().toISOString(),
    apps: [...appDeps.values()],
    databases: dbDeps,
  };
}

export async function writeCloudAppDependenciesFile(
  paprDir: string,
  appId: string,
  deps: CloudAppDependenciesFile,
): Promise<void> {
  const outputPath = path.join(paprDir, "apps", appId, CLOUD_APP_DEPENDENCIES_FILENAME);
  if (deps.apps.length === 0 && deps.databases.length === 0) {
    try {
      await fs.unlink(outputPath);
    } catch {
      /* no file */
    }
    return;
  }
  await fs.writeFile(outputPath, `${JSON.stringify(deps, null, 2)}\n`, "utf8");
}

export async function readCloudAppDependenciesFile(
  appDir: string,
): Promise<CloudAppDependenciesFile | null> {
  const filePath = path.join(appDir, CLOUD_APP_DEPENDENCIES_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as CloudAppDependenciesFile;
  } catch {
    return null;
  }
}

export interface PublishIntegrityValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Hard-block publish when required primary resources are missing after reconciliation. */
export async function validatePublishBundleIntegrity(
  paprDir: string,
  appId: string,
): Promise<PublishIntegrityValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const appDir = path.join(paprDir, "apps", appId);
  const canonicalJobIds = await collectCanonicalAppJobIds(paprDir, appId);

  let sources: AppDataSource[] = [];
  try {
    const raw = await fs.readFile(path.join(appDir, "data-sources.json"), "utf8");
    sources = parseDataSourcesFile(raw).sources;
  } catch {
    sources = [];
  }

  const registry = await readDatabasesRegistry(paprDir);
  const jobBackedSources = sources.filter((s) => s.jobId);
  const registrySources = sources.filter((s) => s.dbId);

  if (jobBackedSources.length === 0 && registrySources.length === 0 && canonicalJobIds.length === 0) {
    return { ok: true, errors, warnings };
  }

  for (const source of jobBackedSources) {
    const jobId = source.jobId!;
    if (!canonicalJobIds.includes(jobId)) {
      errors.push(
        `data-sources references job ${jobId} (${source.alias}) but it is not in Jobs/ or apps/${appId}/jobs/`,
      );
    }
  }

  for (const source of registrySources) {
    const dbId = source.dbId!;
    const record = registry.databases[dbId];
    const ownerAppId = record?.schemaOwnerAppId?.trim();
    if (ownerAppId && ownerAppId !== appId) {
      warnings.push(
        `Database ${dbId} (${source.alias}) is owned by app ${ownerAppId} — publish as a suite or mark optional`,
      );
      continue;
    }
    if (!record || record.status === "tombstone") {
      errors.push(
        `data-sources references database ${dbId} (${source.alias}) but it is missing from data/databases.json`,
      );
    }
  }

  if (canonicalJobIds.length > 0 && jobBackedSources.length === 0) {
    warnings.push(
      `App has ${canonicalJobIds.length} job(s) on disk but none are linked in data-sources.json`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function promoteBundledAppJobsToRegistry(input: {
  localAppId: string;
  localAppDir: string;
  paprHome: string;
}): Promise<{ promotedJobIds: string[] }> {
  const bundledIds = await listBundledAppJobIds(input.localAppDir);
  if (bundledIds.length === 0) {
    return { promotedJobIds: [] };
  }

  const { getJobsService } = await import("./JobsService.js");
  const jobsService = getJobsService();
  await jobsService.initialize();

  const promotedJobIds: string[] = [];
  for (const jobId of bundledIds) {
    const targetDir = path.join(input.paprHome, "Jobs", jobId);
    if (existsSync(path.join(targetDir, "job.json"))) {
      continue;
    }

    const sourceDir = path.join(input.localAppDir, "jobs", jobId);
    let jobJson: Partial<JobRecord> & { id?: string };
    try {
      const raw = await fs.readFile(path.join(sourceDir, "job.json"), "utf8");
      jobJson = JSON.parse(raw) as Partial<JobRecord> & { id?: string };
    } catch {
      continue;
    }

    const name = jobJson.name?.trim() || jobId;
    const type = jobJson.type ?? "python";
    await jobsService.upsertJob(
      {
        id: jobId,
        name,
        type,
        status: "pending",
        appIds: [input.localAppId],
        dependsOn: jobJson.dependsOn ?? [],
        runtimeCalls: jobJson.runtimeCalls ?? [],
        command: jobJson.command,
        requirements: jobJson.requirements,
        schedule: jobJson.schedule,
        retries: jobJson.retries ?? { maxAttempts: 1, backoffMs: 1000 },
        retentionDays: jobJson.retentionDays ?? 14,
        outputMode: jobJson.outputMode ?? "natural",
        memoryPolicy: jobJson.memoryPolicy ?? "none",
        subAgentId: jobJson.subAgentId,
        provider: jobJson.provider,
        model: jobJson.model,
        recipe: jobJson.recipe,
        writeDbIds: jobJson.writeDbIds,
        createdAt: jobJson.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      sourceDir,
    );
    promotedJobIds.push(jobId);
  }

  return { promotedJobIds };
}

async function readJobsIndexIds(paprHome: string): Promise<Set<string>> {
  const indexPath = path.join(paprHome, "data", "jobs.json");
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as { jobs?: Array<{ id: string }> } | Array<{ id: string }>;
    const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
    return new Set(jobs.map((job) => job.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function jobRegisteredOnDisk(paprHome: string, jobId: string, indexIds: Set<string>): boolean {
  return (
    indexIds.has(jobId) &&
    existsSync(path.join(paprHome, "Jobs", jobId, "job.json"))
  );
}

export async function assessCloudInstallHealth(input: {
  paprHome: string;
  appId: string;
  expectedJobIds: string[];
  promotedJobIds?: string[];
}): Promise<CloudInstallHealthReport> {
  const jobIndexIds = await readJobsIndexIds(input.paprHome);

  const appDir = path.join(input.paprHome, "apps", input.appId);
  const deps = await readCloudAppDependenciesFile(appDir);
  const optionalDbIds = new Set(
    (deps?.databases ?? []).filter((d) => !d.required).map((d) => d.dbId),
  );

  let sources: AppDataSource[] = [];
  try {
    const raw = await fs.readFile(path.join(appDir, "data-sources.json"), "utf8");
    sources = parseDataSourcesFile(raw).sources;
  } catch {
    sources = [];
  }

  const expectedJobIds = [
    ...new Set([
      ...input.expectedJobIds,
      ...sources.map((s) => s.jobId).filter((id): id is string => Boolean(id)),
    ]),
  ].sort();

  const registeredJobIds = expectedJobIds.filter((jobId) =>
    jobRegisteredOnDisk(input.paprHome, jobId, jobIndexIds),
  );
  const missingJobIds = expectedJobIds.filter(
    (jobId) => !registeredJobIds.includes(jobId),
  );

  const expectedDbIds = [
    ...new Set(
      sources
        .map((s) => s.dbId?.trim())
        .filter((dbId): dbId is string => Boolean(dbId)),
    ),
  ].sort();

  const registry = await readDatabasesRegistry(input.paprHome);
  const registeredDbIds = expectedDbIds.filter(
    (dbId) => Boolean(registry.databases[dbId]) && registry.databases[dbId]?.status !== "tombstone",
  );
  const missingRequiredDbIds = expectedDbIds.filter(
    (dbId) => !registeredDbIds.includes(dbId) && !optionalDbIds.has(dbId),
  );

  const warnings: string[] = [];
  if (input.promotedJobIds && input.promotedJobIds.length > 0) {
    warnings.push(
      `Promoted ${input.promotedJobIds.length} job(s) from app bundle (Jobs/ sync was incomplete)`,
    );
  }
  for (const dbId of expectedDbIds) {
    if (!registeredDbIds.includes(dbId) && optionalDbIds.has(dbId)) {
      const alias = sources.find((s) => s.dbId === dbId)?.alias ?? dbId;
      warnings.push(
        `Optional database "${alias}" is not installed — related features will be disabled`,
      );
    }
  }

  const ok = missingJobIds.length === 0 && missingRequiredDbIds.length === 0;
  return {
    ok,
    expectedJobIds,
    registeredJobIds,
    missingJobIds,
    expectedDbIds,
    registeredDbIds,
    missingRequiredDbIds,
    warnings,
  };
}
