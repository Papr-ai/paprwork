import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { syncAppLinkedResourcesToTarget } from "../src/gateway/services/copyAppToNamespace.js";
import { runPostMigrationPathRepair } from "../src/gateway/services/postMigrationPathRepair.js";
import { repairWorkspacePortableDataSources } from "../src/gateway/services/portableDataSources.js";

describe("cloud linked resources (install/sync)", () => {
  let sourceHome: string;
  let targetHome: string;
  let publisherAppId: string;
  let localAppId: string;
  let jobId: string;
  let originalPaprHome: string | undefined;

  beforeEach(async () => {
    publisherAppId = randomUUID();
    localAppId = randomUUID();
    jobId = randomUUID();

    sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-source-"));
    targetHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-target-"));

    originalPaprHome = process.env.PAPR_HOME;
    process.env.PAPR_HOME = targetHome;

    const publisherCommand =
      `python3 /Users/publisher/Papr/Jobs/${jobId}/code/run.py ` +
      `--app /Users/publisher/Papr/apps/${publisherAppId}/index.html`;

    await fs.mkdir(path.join(sourceHome, "apps", publisherAppId), {
      recursive: true,
    });
    await fs.mkdir(path.join(sourceHome, "Jobs", jobId, "code"), {
      recursive: true,
    });
    await fs.mkdir(path.join(sourceHome, "data"), { recursive: true });

    await fs.writeFile(
      path.join(sourceHome, "apps", publisherAppId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "db-7c4c3837:gtm",
              type: "sqlite",
              dbId: "db-7c4c3837",
              alias: "gtm",
              dbPath:
                `/Users/publisher/Papr/orgs/org/namespaces/ns/data/databases/myadvice-gtm-metrics/data.db`,
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "main",
              type: "sqlite",
              jobId,
              alias: "main",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(sourceHome, "Jobs", jobId, "job.json"),
      JSON.stringify({ id: jobId, dependsOn: [] }),
    );
    await fs.writeFile(
      path.join(sourceHome, "data", "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          "db-7c4c3837": {
            dbId: "db-7c4c3837",
            localPath:
              "/Users/publisher/Papr/orgs/org/namespaces/ns/data/databases/myadvice-gtm-metrics/data.db",
            tursoShortName: "d-7c4c3837",
            isolation: "shared",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(sourceHome, "data", "jobs.json"),
      JSON.stringify([
        {
          id: jobId,
          name: "Fixture Job",
          type: "python",
          status: "pending",
          appIds: [publisherAppId],
          command: publisherCommand,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    await fs.mkdir(path.join(targetHome, "apps", localAppId), {
      recursive: true,
    });
    await fs.mkdir(path.join(targetHome, "data"), { recursive: true });
    await fs.writeFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "db-7c4c3837:gtm",
              type: "sqlite",
              dbId: "db-7c4c3837",
              alias: "gtm",
              dbPath:
                `/Users/publisher/Papr/orgs/org/namespaces/ns/data/databases/myadvice-gtm-metrics/data.db`,
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "main",
              type: "sqlite",
              jobId,
              alias: "main",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(targetHome, "data", "jobs.json"),
      JSON.stringify([]),
    );
  });

  afterEach(async () => {
    if (originalPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = originalPaprHome;
    }
    await fs.rm(sourceHome, { recursive: true, force: true });
    await fs.rm(targetHome, { recursive: true, force: true });
  });

  it("syncAppLinkedResourcesToTarget copies jobs and remaps appIds", async () => {
    const result = await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourceAppId: publisherAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
    });

    expect(result.copiedJobIds).toContain(jobId);

    const jobsRaw = await fs.readFile(
      path.join(targetHome, "data", "jobs.json"),
      "utf8",
    );
    const jobs = JSON.parse(jobsRaw) as Array<{ id: string; appIds: string[] }>;
    const copied = jobs.find((entry) => entry.id === jobId);
    expect(copied?.appIds).toContain(localAppId);
    expect(copied?.appIds).not.toContain(publisherAppId);

    await expect(
      fs.access(path.join(targetHome, "Jobs", jobId, "code")),
    ).resolves.toBeUndefined();

    const dsRaw = await fs.readFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      "utf8",
    );
    const ds = JSON.parse(dsRaw) as {
      sources: Array<{ dbId?: string; dbPath?: string }>;
    };
    const registrySource = ds.sources.find((s) => s.dbId === "db-7c4c3837");
    expect(registrySource?.dbPath).toContain(
      `${path.sep}data${path.sep}databases${path.sep}myadvice-gtm-metrics${path.sep}data.db`,
    );
    expect(registrySource?.dbPath).not.toContain("/Users/publisher/");
  });

  it("postMigrationPathRepair repairs hardcoded publisher paths", async () => {
    await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourceAppId: publisherAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
    });

    await repairWorkspacePortableDataSources();
    await runPostMigrationPathRepair({
      dryRun: false,
      includeApps: false,
      delayMs: 0,
      scopePaprHome: targetHome,
    });

    const jobsRaw = await fs.readFile(
      path.join(targetHome, "data", "jobs.json"),
      "utf8",
    );
    const jobs = JSON.parse(jobsRaw) as Array<{ id: string; command?: string }>;
    const command = jobs.find((entry) => entry.id === jobId)?.command ?? "";

    expect(command).not.toContain("/Users/publisher/Papr");
    expect(command).toMatch(/\$JOB_DIR|\$PAPR_HOME/);
  });

  it("hydrates registry dbPath from linked-databases.json label when localPath is empty", async () => {
    const dbId = "db-2d6b4294";
    const slug = "gtm-foundations";

    await fs.writeFile(
      path.join(sourceHome, "apps", publisherAppId, "linked-databases.json"),
      JSON.stringify(
        {
          version: 1,
          databases: {
            [dbId]: {
              dbId,
              localPath: "",
              tursoShortName: "d-2d6b4294",
              label: "GTM Foundations",
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
    );

    await fs.writeFile(
      path.join(targetHome, "apps", localAppId, "linked-databases.json"),
      JSON.stringify(
        {
          version: 1,
          databases: {
            [dbId]: {
              dbId,
              localPath: "",
              tursoShortName: "d-2d6b4294",
              label: "GTM Foundations",
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
    );

    const sourceDbDir = path.join(sourceHome, "data", "databases", slug);
    await fs.mkdir(sourceDbDir, { recursive: true });
    await fs.writeFile(path.join(sourceDbDir, "data.db"), "sqlite", "utf8");

    await fs.writeFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: `${dbId}:gtm`,
              type: "sqlite",
              dbId,
              alias: "gtm",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourceAppId: publisherAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
    });

    const targetRegistry = JSON.parse(
      await fs.readFile(path.join(targetHome, "data", "databases.json"), "utf8"),
    ) as { databases: Record<string, { localPath?: string }> };
    expect(targetRegistry.databases[dbId]?.localPath).toBe(
      path.join(targetHome, "data", "databases", slug, "data.db"),
    );

    const dsRaw = await fs.readFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      "utf8",
    );
    const ds = JSON.parse(dsRaw) as {
      sources: Array<{ dbId?: string; dbPath?: string }>;
    };
    const source = ds.sources.find((entry) => entry.dbId === dbId);
    expect(source?.dbPath).toBe(
      path.join(targetHome, "data", "databases", slug, "data.db"),
    );

    await fs.access(
      path.join(targetHome, "data", "databases", slug, "data.db"),
    );
  });
});
