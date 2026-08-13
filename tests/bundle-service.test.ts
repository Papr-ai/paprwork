import os from "os";
import { STANDALONE_APP_ID } from "../src/gateway/services/jobs/appIds.js";
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
  // HOME alone is not enough: getPaprRoot() prefers ~/Papr/.active-workspace.json
  // (read from the REAL home) and re-syncs PAPR_HOME from it, so without this
  // every createApp/createJob below lands in the developer's live workspace.
  process.env.PAPR_HOME = path.join(root, "Papr");
  await fs.mkdir(process.env.PAPR_HOME, { recursive: true });
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
      appIds: [STANDALONE_APP_ID],
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
      appIds: [STANDALONE_APP_ID],
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

  test("scrubs private artifacts from exported bundle", async () => {
    const { bundleService, appService, jobsService, root } = await createWorkspace();
    const app = await appService.createApp("Scrub App", "desc", [
      { filename: "index.html", content: "<h1>Hi</h1>" },
      {
        filename: "metadata.json",
        content: JSON.stringify({
          organizationId: "org-test",
          namespaceId: "ns-test",
          title: "Scrub App",
        }),
      },
    ]);
    const appPath = await appService.getAppPath(app.id);
    expect(appPath).toBeTruthy();
    await fs.mkdir(path.join(appPath!, "dist"), { recursive: true });
    await fs.writeFile(path.join(appPath!, "dist", "app.js"), "compiled", "utf8");
    await fs.writeFile(path.join(appPath!, "app.ts.bak-bg"), "backup", "utf8");
    await fs.writeFile(path.join(appPath!, ".groq_key"), "gsk_test_should_not_export", "utf8");

    const job = await jobsService.createJob({
      name: "Scrub Job",
      appIds: [STANDALONE_APP_ID],
      type: "python",
      command: "python3 -c \"print('ok')\"",
    });
    const jobPath = await jobsService.getJobPath(job.id);
    expect(jobPath).toBeTruthy();
    await fs.writeFile(
      path.join(jobPath!, "pending_meetings.json"),
      '[{"title":"private"}]',
      "utf8",
    );

    const { scrubReport } = await bundleService.exportBundle({
      appId: app.id,
      bundleId: "bundle-scrub",
      name: "Scrub Bundle",
      version: "1.0.0",
      jobIds: [job.id],
    });

    const bundlePath = path.join(root, "Papr", "bundles", "bundle-scrub");
    expect(scrubReport.removedFiles.some((f) => f.includes("app.ts.bak-bg"))).toBe(true);
    expect(scrubReport.removedFiles.some((f) => f.includes(".groq_key"))).toBe(true);
    expect(scrubReport.removedFiles.some((f) => f.includes("pending_meetings.json"))).toBe(true);
    expect(scrubReport.removedDirs.some((d) => d.includes("dist"))).toBe(true);

    const metadataRaw = await fs.readFile(
      path.join(bundlePath, "apps", app.id, "metadata.json"),
      "utf8",
    );
    const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    expect(metadata.organizationId).toBeUndefined();
    expect(metadata.namespaceId).toBeUndefined();
    expect(scrubReport.leakedSecrets).toHaveLength(0);
  });
});
