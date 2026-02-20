import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type {
  BundleDatabaseSpec,
  BundleJobSpec,
  BundleManifest,
  RuntimeType,
} from "../../core/types/bundles.js";
import {
  BUNDLE_SCHEMA_VERSION,
  parseBundleManifest,
} from "../../core/types/bundles.js";
import { AppService, getAppService, type MiniApp } from "./AppService.js";
import {
  JobsService,
  getJobsService,
  type JobRecord,
  type JobType,
} from "./JobsService.js";

export interface ExportBundleInput {
  appId: string;
  bundleId: string;
  name: string;
  version: string;
  description?: string;
  minPaprworkVersion?: string;
  jobIds: string[];
  sqlite?: BundleDatabaseSpec[];
}

export interface ImportBundleInput {
  sourcePath: string;
}

export interface BundleSummary {
  bundleId: string;
  name: string;
  version: string;
  path: string;
  createdAt: string;
}

let bundleServiceInstance: BundleService | null = null;

function mapJobTypeToRuntime(type: JobType): RuntimeType {
  if (type === "shell") {
    return "bash";
  }
  if (type === "subagent") {
    return "agent";
  }
  if (
    type === "bash" ||
    type === "node" ||
    type === "python" ||
    type === "swift" ||
    type === "agent"
  ) {
    return type;
  }
  return "bash";
}

function mapRuntimeToJobType(type: RuntimeType): JobType {
  if (type === "bash") {
    return "bash";
  }
  if (
    type === "node" ||
    type === "python" ||
    type === "swift" ||
    type === "agent"
  ) {
    return type;
  }
  return "shell";
}

export class BundleService {
  private bundlesRootPath: string;
  private appService: AppService;
  private jobsService: JobsService;
  private initialized = false;

  constructor(
    appService: AppService = getAppService(),
    jobsService: JobsService = getJobsService(),
  ) {
    this.appService = appService;
    this.jobsService = jobsService;
    this.bundlesRootPath = path.join(os.homedir(), "PAPR", "bundles");
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(this.bundlesRootPath, { recursive: true });
    this.initialized = true;
  }

  private getBundlePath(bundleId: string): string {
    return path.join(this.bundlesRootPath, bundleId);
  }

  private getManifestPath(bundleId: string): string {
    return path.join(this.getBundlePath(bundleId), "manifest.json");
  }

  private async buildJobSpec(job: JobRecord): Promise<BundleJobSpec> {
    return {
      id: job.id,
      name: job.name,
      type: mapJobTypeToRuntime(job.type),
      command: job.command,
      dependsOn: [],
      env: {},
      outputTables: [],
    };
  }

  async exportBundle(input: ExportBundleInput): Promise<BundleManifest> {
    await this.initialize();
    const app = await this.appService.getApp(input.appId);
    const appPath = await this.appService.getAppPath(input.appId);
    if (!app || !appPath) {
      throw new Error(`App not found: ${input.appId}`);
    }

    const destinationPath = this.getBundlePath(input.bundleId);
    try {
      await fs.access(destinationPath);
      throw new Error(`Bundle already exists: ${input.bundleId}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.mkdir(destinationPath, { recursive: true });
    const appRelPath = path.join("apps", app.id);
    const appDest = path.join(destinationPath, appRelPath);
    await fs.mkdir(path.dirname(appDest), { recursive: true });
    await fs.cp(appPath, appDest, { recursive: true });

    const jobSpecs: BundleJobSpec[] = [];
    for (const jobId of input.jobIds) {
      const job = await this.jobsService.getJob(jobId);
      const jobPath = await this.jobsService.getJobPath(jobId);
      if (!job || !jobPath) {
        throw new Error(`Job not found: ${jobId}`);
      }
      const jobRelPath = path.join("jobs", job.id);
      const jobDest = path.join(destinationPath, jobRelPath);
      await fs.mkdir(path.dirname(jobDest), { recursive: true });
      await fs.cp(jobPath, jobDest, { recursive: true });
      jobSpecs.push(await this.buildJobSpec(job));
    }

    const manifest: BundleManifest = parseBundleManifest({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId: input.bundleId,
      name: input.name,
      version: input.version,
      createdAt: new Date().toISOString(),
      minPaprworkVersion: input.minPaprworkVersion ?? "2.0.0",
      description: input.description,
      app: {
        id: app.id,
        name: app.title,
        version: input.version,
        entryFile: "index.html",
        appPath: appRelPath,
        description: app.description,
      },
      jobs: jobSpecs,
      sqlite: input.sqlite ?? [],
      deploymentProfiles: [
        {
          id: "local-default",
          name: "Local Default",
          runtimeTarget: "local",
          environment: {},
        },
      ],
      sync: {
        preferredRoot: "~/PAPR",
        bundleSubpath: "bundles",
        cloudReady: true,
      },
    });

    await fs.writeFile(
      this.getManifestPath(input.bundleId),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    return manifest;
  }

  async importBundle(input: ImportBundleInput): Promise<BundleManifest> {
    await this.initialize();
    const sourceManifestPath = path.join(input.sourcePath, "manifest.json");
    const raw = await fs.readFile(sourceManifestPath, "utf8");
    const manifest = parseBundleManifest(JSON.parse(raw) as unknown);

    const destination = this.getBundlePath(manifest.bundleId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(input.sourcePath, destination, { recursive: true });

    const appSource = path.join(destination, manifest.app.appPath);
    const appMetadata: MiniApp = {
      id: manifest.app.id,
      title: manifest.app.name,
      description: manifest.app.description ?? "",
      type: "app",
      createdAt: manifest.createdAt,
      updatedAt: new Date().toISOString(),
      favorite: false,
    };
    await this.appService.upsertApp(appMetadata, appSource);

    for (const jobSpec of manifest.jobs) {
      const sourceJobPath = path.join(destination, "jobs", jobSpec.id);
      const now = new Date().toISOString();
      const jobRecord: JobRecord = {
        id: jobSpec.id,
        name: jobSpec.name,
        type: mapRuntimeToJobType(jobSpec.type),
        status: "pending",
        command: jobSpec.command,
        createdAt: manifest.createdAt,
        updatedAt: now,
      };
      await this.jobsService.upsertJob(jobRecord, sourceJobPath);
    }

    return manifest;
  }

  async listBundles(): Promise<BundleSummary[]> {
    await this.initialize();
    const entries = await fs.readdir(this.bundlesRootPath, {
      withFileTypes: true,
    });
    const summaries: BundleSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const bundlePath = path.join(this.bundlesRootPath, entry.name);
      const manifestPath = path.join(bundlePath, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = parseBundleManifest(JSON.parse(raw) as unknown);
        summaries.push({
          bundleId: manifest.bundleId,
          name: manifest.name,
          version: manifest.version,
          path: bundlePath,
          createdAt: manifest.createdAt,
        });
      } catch {
        continue;
      }
    }
    return summaries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
}

export function getBundleService(): BundleService {
  if (!bundleServiceInstance) {
    bundleServiceInstance = new BundleService();
  }
  return bundleServiceInstance;
}

export async function initializeBundleService(): Promise<BundleService> {
  const service = getBundleService();
  await service.initialize();
  return service;
}
