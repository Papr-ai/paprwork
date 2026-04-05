import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test } from "vitest";
import { AppService } from "../src/gateway/services/AppService.js";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { BundleService } from "../src/gateway/services/BundleService.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function createWorkspace(): Promise<{
  root: string;
  appService: AppService;
  jobsService: JobsService;
  bundleService: BundleService;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-bundle-test-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  const appService = new AppService();
  const jobsService = new JobsService();
  await appService.initialize();
  await jobsService.initialize();
  const bundleService = new BundleService(appService, jobsService);
  await bundleService.initialize();
  return { root, appService, jobsService, bundleService };
}

describe("BundleService", () => {
  test("exports and lists bundles", async () => {
    const { bundleService, appService, jobsService } = await createWorkspace();
    const app = await appService.createApp("Dash", "Bundle app", [
      { filename: "index.html", content: "<h1>Hi</h1>" },
    ]);
    const job = await jobsService.createJob({
      name: "Collector",
      type: "python",
      command: "python3 -c \"print('ok')\"",
    });

    const manifest = await bundleService.exportBundle({
      appId: app.id,
      bundleId: "bundle-one",
      name: "Bundle One",
      version: "1.0.0",
      jobIds: [job.id],
    });

    expect(manifest.bundleId).toBe("bundle-one");
    const bundles = await bundleService.listBundles();
    expect(bundles).toHaveLength(1);
    expect(bundles[0].bundleId).toBe("bundle-one");
  });

  test("imports bundle into a new workspace", async () => {
    const source = await createWorkspace();
    const app = await source.appService.createApp("Source App", "desc", [
      { filename: "index.html", content: "<h1>Source</h1>" },
    ]);
    const job = await source.jobsService.createJob({
      name: "Source Job",
      type: "bash",
      command: "echo source",
    });
    await source.bundleService.exportBundle({
      appId: app.id,
      bundleId: "bundle-importable",
      name: "Importable",
      version: "1.0.0",
      jobIds: [job.id],
    });

    const bundlePath = path.join(source.root, "Papr", "bundles", "bundle-importable");
    const target = await createWorkspace();
    await target.bundleService.importBundle({ sourcePath: bundlePath });

    const importedBundles = await target.bundleService.listBundles();
    expect(importedBundles.some((entry) => entry.bundleId === "bundle-importable")).toBe(true);

    const apps = await target.appService.listApps();
    expect(apps.some((entry) => entry.id === app.id)).toBe(true);

    const jobs = await target.jobsService.listJobs();
    expect(jobs.some((entry) => entry.id === job.id)).toBe(true);
  });
});
