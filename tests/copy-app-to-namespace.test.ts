import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import {
  ensureWorkspaceLayout,
  writeActiveWorkspacePointer,
} from "../src/core/utils/paprWorkspace.js";
import {
  copyAppToNamespace,
  CopyAppError,
} from "../src/gateway/services/copyAppToNamespace.js";
import type { MiniApp } from "../src/gateway/services/AppService.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";
import {
  parseDataSourcesFile,
  serializeDataSourcesFile,
} from "../src/gateway/services/appDataSources.js";
import { parseCloudAppMetadataFile } from "../src/core/utils/cloudAppMetadata.js";

describe("copyAppToNamespace", () => {
  let originalHome: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    testHomeDir = path.join(
      os.tmpdir(),
      `paprwork-copy-app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    process.env.HOME = testHomeDir;
    await fs.mkdir(testHomeDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(testHomeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  async function seedNamespace(
    organizationId: string,
    namespaceId: string,
    apps: MiniApp[],
    appFiles: Record<string, { html: string; dataSources?: string }>,
    jobs: JobRecord[] = [],
    jobDirs: Record<string, { hasDb?: boolean }> = {},
  ): Promise<string> {
    const pointer = await ensureWorkspaceLayout({
      organizationId,
      namespaceId,
    });
    await fs.mkdir(path.join(pointer.paprHome, "data"), { recursive: true });
    await fs.writeFile(
      path.join(pointer.paprHome, "data", "apps.json"),
      JSON.stringify(apps, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(pointer.paprHome, "data", "jobs.json"),
      JSON.stringify(jobs, null, 2),
      "utf8",
    );
    for (const [appId, files] of Object.entries(appFiles)) {
      const appDir = path.join(pointer.paprHome, "apps", appId);
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(path.join(appDir, "index.html"), files.html, "utf8");
      if (files.dataSources) {
        await fs.writeFile(
          path.join(appDir, "data-sources.json"),
          files.dataSources,
          "utf8",
        );
      }
    }
    for (const [jobId, meta] of Object.entries(jobDirs)) {
      const jobDir = path.join(pointer.paprHome, "Jobs", jobId);
      await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
      if (meta.hasDb) {
        await fs.writeFile(path.join(jobDir, "data", "data.db"), "sqlite", "utf8");
      }
      await fs.writeFile(
        path.join(jobDir, "job.json"),
        JSON.stringify({ id: jobId }),
        "utf8",
      );
    }
    return pointer.paprHome;
  }

  test("copies app bundle and leaves source namespace unchanged", async () => {
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const jobId = "11111111-2222-3333-4444-555555555555";
    const app: MiniApp = {
      id: appId,
      title: "Sales Dashboard",
      description: "Demo",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const job: JobRecord = {
      id: jobId,
      name: "Sync",
      type: "python",
      status: "completed",
      appIds: [appId],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const sourceHome = await seedNamespace("org-a", "ns-source", [app], {
      [appId]: { html: "<h1>Dashboard</h1>" },
    }, [job], { [jobId]: { hasDb: true } });

    const legacyDbPath = path.join(sourceHome, "Jobs", jobId, "data", "data.db");
    await fs.writeFile(
      path.join(sourceHome, "apps", appId, "data-sources.json"),
      serializeDataSourcesFile({
        sources: [
          {
            id: "src-1",
            type: "sqlite",
            jobId,
            alias: "main",
            dbPath: legacyDbPath,
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    await seedNamespace("org-a", "ns-target", [], {}, []);

    const activePointer = await ensureWorkspaceLayout({
      organizationId: "org-a",
      namespaceId: "ns-source",
    });
    await writeActiveWorkspacePointer(activePointer);

    const result = await copyAppToNamespace({
      appId,
      targetOrganizationId: "org-a",
      targetNamespaceId: "ns-target",
      sourcePaprHome: sourceHome,
    });

    expect(result.copiedJobIds).toEqual([jobId]);

    const sourceApps = JSON.parse(
      await fs.readFile(path.join(sourceHome, "data", "apps.json"), "utf8"),
    ) as MiniApp[];
    expect(sourceApps).toHaveLength(1);
    await fs.access(path.join(sourceHome, "apps", appId));

    const targetHome = path.join(
      testHomeDir,
      "Papr",
      "orgs",
      "org-a",
      "namespaces",
      "ns-target",
    );
    const targetApps = JSON.parse(
      await fs.readFile(path.join(targetHome, "data", "apps.json"), "utf8"),
    ) as MiniApp[];
    expect(targetApps).toHaveLength(1);
    expect(targetApps[0]?.title).toBe("Sales Dashboard");
    expect(targetApps[0]?.organizationId).toBe("org-a");
    expect(targetApps[0]?.namespaceId).toBe("ns-target");

    const targetMetadata = parseCloudAppMetadataFile(
      await fs.readFile(
        path.join(targetHome, "apps", appId, "metadata.json"),
        "utf8",
      ),
    );
    expect(targetMetadata?.organizationId).toBe("org-a");
    expect(targetMetadata?.namespaceId).toBe("ns-target");

    const targetJobs = JSON.parse(
      await fs.readFile(path.join(targetHome, "data", "jobs.json"), "utf8"),
    ) as JobRecord[];
    expect(targetJobs).toHaveLength(1);
    expect(targetJobs[0]?.id).toBe(jobId);
    expect(targetJobs[0]?.appIds).toEqual([appId]);
    expect(targetJobs[0]?.status).toBe("pending");

    await fs.access(path.join(targetHome, "Jobs", jobId, "data", "data.db"));

    const dataSourcesRaw = await fs.readFile(
      path.join(targetHome, "apps", appId, "data-sources.json"),
      "utf8",
    );
    const dataSources = parseDataSourcesFile(dataSourcesRaw);
    expect(dataSources.sources[0]?.dbPath).toBe(
      path.join(targetHome, "Jobs", jobId, "data", "data.db"),
    );
  });

  test("copies shared registry database files and remaps registry paths", async () => {
    const appId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const dbId = "db-7c4c3837";
    const slug = "gtm-metrics";
    const app: MiniApp = {
      id: appId,
      title: "Registry App",
      description: "Uses shared DB",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const sourceHome = await seedNamespace("org-d", "ns-reg-source", [app], {
      [appId]: {
        html: "<h1>Registry</h1>",
        dataSources: serializeDataSourcesFile({
          sources: [
            {
              id: `${dbId}:main`,
              type: "sqlite",
              dbId,
              alias: "main",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      },
    });

    const sourceDbDir = path.join(sourceHome, "data", "databases", slug);
    await fs.mkdir(sourceDbDir, { recursive: true });
    await fs.writeFile(path.join(sourceDbDir, "data.db"), "sqlite-registry", "utf8");
    await fs.writeFile(
      path.join(sourceHome, "data", "databases.json"),
      JSON.stringify(
        {
          version: 1,
          databases: {
            [dbId]: {
              dbId,
              localPath: path.join(sourceDbDir, "data.db"),
              tursoShortName: "d-7c4c3837",
              isolation: "shared",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await seedNamespace("org-d", "ns-reg-target", [], {}, []);

    const activePointer = await ensureWorkspaceLayout({
      organizationId: "org-d",
      namespaceId: "ns-reg-source",
    });
    await writeActiveWorkspacePointer(activePointer);

    const result = await copyAppToNamespace({
      appId,
      targetOrganizationId: "org-d",
      targetNamespaceId: "ns-reg-target",
      sourcePaprHome: sourceHome,
    });

    expect(result.copiedRegistryDbSlugs).toEqual([slug]);

    const targetHome = path.join(
      testHomeDir,
      "Papr",
      "orgs",
      "org-d",
      "namespaces",
      "ns-reg-target",
    );
    await fs.access(path.join(targetHome, "data", "databases", slug, "data.db"));

    const dataSourcesRaw = await fs.readFile(
      path.join(targetHome, "apps", appId, "data-sources.json"),
      "utf8",
    );
    const dataSources = parseDataSourcesFile(dataSourcesRaw);
    expect(dataSources.sources[0]?.dbPath).toBe(
      path.join(targetHome, "data", "databases", slug, "data.db"),
    );
  });

  test("repairs hardcoded Papr paths in copied job commands", async () => {
    const appId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const jobId = "22222222-3333-4444-5555-666666666666";
    const app: MiniApp = {
      id: appId,
      title: "Path Repair App",
      description: "",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const hardcodedCommand =
      `python3 ~/Papr/orgs/org-e/namespaces/ns-path-source/Jobs/${jobId}/code/run.py`;

    const sourceHome = await seedNamespace(
      "org-e",
      "ns-path-source",
      [app],
      { [appId]: { html: "<h1>Paths</h1>" } },
      [
        {
          id: jobId,
          name: "Runner",
          type: "python",
          status: "completed",
          appIds: [appId],
          command: hardcodedCommand,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { [jobId]: { hasDb: false } },
    );

    await seedNamespace("org-e", "ns-path-target", [], {}, []);

    const activePointer = await ensureWorkspaceLayout({
      organizationId: "org-e",
      namespaceId: "ns-path-source",
    });
    await writeActiveWorkspacePointer(activePointer);

    await copyAppToNamespace({
      appId,
      targetOrganizationId: "org-e",
      targetNamespaceId: "ns-path-target",
      sourcePaprHome: sourceHome,
    });

    const targetHome = path.join(
      testHomeDir,
      "Papr",
      "orgs",
      "org-e",
      "namespaces",
      "ns-path-target",
    );
    const targetJobs = JSON.parse(
      await fs.readFile(path.join(targetHome, "data", "jobs.json"), "utf8"),
    ) as JobRecord[];
    const command = targetJobs.find((job) => job.id === jobId)?.command ?? "";
    expect(command).not.toContain("ns-path-source");
    expect(command).toMatch(/\$JOB_DIR|\$PAPR_HOME/);
  });

  test("suffixes title when target namespace already has same name", async () => {
    const movingId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const existingId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const movingApp: MiniApp = {
      id: movingId,
      title: "Pipeline",
      description: "Move me",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const existingApp: MiniApp = {
      id: existingId,
      title: "Pipeline",
      description: "Stay",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const sourceHome = await seedNamespace(
      "org-b",
      "ns-one",
      [movingApp],
      { [movingId]: { html: "<h1>Move</h1>" } },
    );
    await seedNamespace(
      "org-b",
      "ns-two",
      [existingApp],
      { [existingId]: { html: "<h1>Stay</h1>" } },
    );

    const activePointer = await ensureWorkspaceLayout({
      organizationId: "org-b",
      namespaceId: "ns-one",
    });
    await writeActiveWorkspacePointer(activePointer);

    const result = await copyAppToNamespace({
      appId: movingId,
      targetOrganizationId: "org-b",
      targetNamespaceId: "ns-two",
      sourcePaprHome: sourceHome,
    });

    expect(result.titleRenamed).toBe(true);
    expect(result.title).toBe("Pipeline_1");
  });

  test("rejects copying into the active namespace", async () => {
    const appId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const app: MiniApp = {
      id: appId,
      title: "Same NS",
      description: "",
      type: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const sourceHome = await seedNamespace("org-c", "ns-only", [app], {
      [appId]: { html: "<h1>Hi</h1>" },
    });
    const activePointer = await ensureWorkspaceLayout({
      organizationId: "org-c",
      namespaceId: "ns-only",
    });
    await writeActiveWorkspacePointer(activePointer);

    await expect(
      copyAppToNamespace({
        appId,
        targetOrganizationId: "org-c",
        targetNamespaceId: "ns-only",
        sourcePaprHome: sourceHome,
      }),
    ).rejects.toMatchObject({
      code: "same_namespace",
    } satisfies Partial<CopyAppError>);
  });
});
