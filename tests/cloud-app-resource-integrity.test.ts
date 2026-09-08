import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  assessCloudInstallHealth,
  collectCanonicalAppJobIds,
  detectCrossAppDependencies,
  listBundledAppJobIds,
  reconcileAppDataSourcesForPublish,
  validatePublishBundleIntegrity,
} from "../src/gateway/services/cloudAppResourceIntegrity.js";
import { resetJobsServiceSingletonForTests } from "../src/gateway/services/JobsService.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("cloudAppResourceIntegrity", () => {
  useIsolatedPaprWorkspace("cloud-app-resource-integrity");
  let paprHome: string;
  let appId: string;
  let jobId: string;
  let externalAppId: string;
  let externalDbId: string;

  beforeEach(async () => {
    resetJobsServiceSingletonForTests();
    appId = randomUUID();
    jobId = randomUUID();
    externalAppId = randomUUID();
    externalDbId = "db-e98731d0";

    paprHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-integrity-"));
    process.env.PAPR_HOME = paprHome;

    await fs.mkdir(path.join(paprHome, "apps", appId, "jobs", jobId, "code"), {
      recursive: true,
    });
    await fs.mkdir(path.join(paprHome, "Jobs", jobId, "code"), {
      recursive: true,
    });
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });

    const phantomJobId = randomUUID();

    await fs.writeFile(
      path.join(paprHome, "apps", appId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: "main",
              type: "sqlite",
              jobId,
              alias: "main",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "stale",
              type: "sqlite",
              jobId: phantomJobId,
              alias: "stale",
              dbPath: "",
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: externalDbId,
              type: "sqlite",
              dbId: externalDbId,
              alias: "contacts",
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
      path.join(paprHome, "apps", appId, "jobs", jobId, "job.json"),
      JSON.stringify({
        id: jobId,
        name: "Bundled Job",
        type: "python",
        appIds: [appId],
        command: "python3 code/run.py",
      }),
    );

    await fs.writeFile(
      path.join(paprHome, "Jobs", jobId, "job.json"),
      JSON.stringify({
        id: jobId,
        name: "Registry Job",
        type: "python",
        appIds: [appId],
        command: "python3 code/run.py",
      }),
    );

    await fs.writeFile(
      path.join(paprHome, "data", "jobs.json"),
      JSON.stringify([
        {
          id: jobId,
          name: "Registry Job",
          type: "python",
          status: "pending",
          appIds: [appId],
          command: "python3 code/run.py",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    await fs.writeFile(
      path.join(paprHome, "data", "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          [externalDbId]: {
            dbId: externalDbId,
            localPath: "",
            schemaOwnerAppId: externalAppId,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    await fs.writeFile(
      path.join(paprHome, "data", "apps.json"),
      JSON.stringify([
        { id: appId, title: "Lead Prospector" },
        { id: externalAppId, title: "Contact Enrichment", slug: "contact-enrichment" },
      ]),
    );

    await reconcileAppDataSourcesForPublish(paprHome, appId);
  });

  afterEach(async () => {
    resetJobsServiceSingletonForTests();
    await fs.rm(paprHome, { recursive: true, force: true, maxRetries: 3 });
    delete process.env.PAPR_HOME;
  });

  it("lists bundled app job ids", async () => {
    const ids = await listBundledAppJobIds(path.join(paprHome, "apps", appId));
    expect(ids).toEqual([jobId]);
  });

  it("reconciles data-sources by removing phantom jobs", async () => {
    const raw = await fs.readFile(
      path.join(paprHome, "apps", appId, "data-sources.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { sources: Array<{ jobId?: string }> };
    expect(parsed.sources.some((s) => s.jobId === jobId)).toBe(true);
    expect(parsed.sources.filter((s) => s.jobId).length).toBe(1);
    expect(parsed.sources.length).toBe(2);
  });

  it("detects cross-app database dependencies", async () => {
    const deps = await detectCrossAppDependencies(paprHome, appId);
    expect(deps.apps).toHaveLength(1);
    expect(deps.apps[0]?.appId).toBe(externalAppId);
    expect(deps.databases[0]?.alias).toBe("contacts");
    expect(deps.databases[0]?.required).toBe(false);
  });

  it("collects canonical job ids from Jobs and bundled folders", async () => {
    const ids = await collectCanonicalAppJobIds(paprHome, appId);
    expect(ids).toEqual([jobId]);
  });

  it("passes publish integrity when required jobs exist", async () => {
    await reconcileAppDataSourcesForPublish(paprHome, appId);
    const integrity = await validatePublishBundleIntegrity(paprHome, appId);
    expect(integrity.ok).toBe(true);
  });

  it("promotes bundled jobs into Jobs registry when missing", async () => {
    const onlyBundledJobId = randomUUID();
    const localAppId = randomUUID();
    const localAppDir = path.join(paprHome, "apps", localAppId);
    await fs.mkdir(path.join(localAppDir, "jobs", onlyBundledJobId, "code"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(localAppDir, "jobs", onlyBundledJobId, "job.json"),
      JSON.stringify({
        id: onlyBundledJobId,
        name: "Fallback Job",
        type: "python",
        appIds: [localAppId],
        command: "python3 code/run.py",
      }),
    );
    await fs.writeFile(
      path.join(localAppDir, "jobs", onlyBundledJobId, "code", "run.py"),
      "print('ok')\n",
    );

    const targetDir = path.join(paprHome, "Jobs", onlyBundledJobId);
    await fs.cp(
      path.join(localAppDir, "jobs", onlyBundledJobId),
      targetDir,
      { recursive: true },
    );
    const indexRaw = await fs.readFile(path.join(paprHome, "data", "jobs.json"), "utf8");
    const index = JSON.parse(indexRaw) as Array<{ id: string }>;
    index.push({
      id: onlyBundledJobId,
      name: "Fallback Job",
      type: "python",
      status: "pending",
      appIds: [localAppId],
      command: "python3 code/run.py",
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(path.join(paprHome, "data", "jobs.json"), JSON.stringify(index));

    const health = await assessCloudInstallHealth({
      paprHome,
      appId: localAppId,
      expectedJobIds: [onlyBundledJobId],
    });
    expect(health.ok).toBe(true);
    expect(health.registeredJobIds).toContain(onlyBundledJobId);
  });

  it("reports install health with optional missing databases as warnings only", async () => {
    await fs.writeFile(
      path.join(paprHome, "data", "databases.json"),
      JSON.stringify({ version: 1, databases: {} }),
    );
    await fs.writeFile(
      path.join(paprHome, "apps", appId, "papr-cloud-dependencies.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        updatedAt: new Date().toISOString(),
        apps: [],
        databases: [
          {
            dbId: externalDbId,
            alias: "contacts",
            ownerAppId: externalAppId,
            required: false,
          },
        ],
      }),
    );

    const health = await assessCloudInstallHealth({
      paprHome,
      appId,
      expectedJobIds: [jobId],
    });

    expect(health.ok).toBe(true);
    expect(health.missingRequiredDbIds).toEqual([]);
    expect(health.warnings.some((w) => w.includes("Optional database"))).toBe(
      true,
    );
  });

  it("fails install health when required jobs are missing", async () => {
    await reconcileAppDataSourcesForPublish(paprHome, appId);
    const missingJobId = randomUUID();
    const health = await assessCloudInstallHealth({
      paprHome,
      appId,
      expectedJobIds: [jobId, missingJobId],
    });

    expect(health.ok).toBe(false);
    expect(health.missingJobIds).toContain(missingJobId);
  });
});
