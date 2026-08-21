import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { dbIdFromPath } from "../src/gateway/services/DatabaseRegistryService.js";
import {
  collectAppOpFiles,
  resolveWriterSyncedLocalPaths,
} from "../src/gateway/services/syncV3/collectAppOpFiles.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePaprDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-app-ops-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("collectAppOpFiles", () => {
  const appId = "app-dashboard";

  function seedWorkspace(paprDir: string): void {
    writeJson(path.join(paprDir, "apps", appId, "metadata.json"), {
      title: "Dashboard",
    });
    writeJson(path.join(paprDir, "apps", appId, "data-sources.json"), {
      sources: [
        {
          id: "job:worker",
          type: "job",
          jobId: "job-worker",
          alias: "worker",
        },
      ],
    });
    writeJson(path.join(paprDir, "data", "jobs.json"), {
      jobs: [
        {
          id: "job-worker",
          name: "Worker",
          type: "python",
          appIds: [appId],
          status: "pending",
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const jobDir = path.join(paprDir, "Jobs", "job-worker");
    fs.mkdirSync(path.join(jobDir, "code"), { recursive: true });
    fs.writeFileSync(path.join(jobDir, "code", "run.py"), "print('ok')\n");
    writeJson(path.join(jobDir, "job.json"), {
      id: "job-worker",
      name: "Worker",
      type: "python",
      appIds: [appId],
      status: "running",
      lastRunAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(jobDir, "job.runtime.json"),
      '{"status":"running"}\n',
    );
    fs.mkdirSync(path.join(jobDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(jobDir, "data", "data.db"), "sqlite");

    const dbPath = path.join(paprDir, "data", "databases", "billing", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    fs.mkdirSync(path.join(paprDir, "data", "databases", "billing", "migrations"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(paprDir, "data", "databases", "billing", "migrations", "0001_init.sql"),
      "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);\n",
    );

    const dbId = dbIdFromPath(dbPath);
    writeJson(path.join(paprDir, "data", "databases.json"), {
      version: 1,
      databases: {
        [dbId]: {
          dbId,
          localPath: dbPath,
          tursoShortName: `d-${dbId.slice(3)}`,
          label: "Billing",
          schemaOwnerAppId: appId,
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
  }

  it("includes app files, linked jobs under jobs/{id}/, and owner migrations", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    const { files, rejected } = await collectAppOpFiles(paprDir, appId);

    expect(rejected).toEqual([]);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toContain("metadata.json");
    expect(paths).toContain("jobs/job-worker/code/run.py");
    expect(paths).toContain("jobs/job-worker/job.json");
    expect(paths).toContain("databases/billing/migrations/0001_init.sql");
    expect(paths.some((p) => p.includes("data.db"))).toBe(false);
    expect(paths.some((p) => p.includes("job.runtime.json"))).toBe(false);

    const jobJson = files.find((file) => file.path === "jobs/job-worker/job.json");
    expect(jobJson?.content).toBeDefined();
    const parsed = JSON.parse(jobJson!.content!) as Record<string, unknown>;
    expect(parsed.status).toBeUndefined();
    expect(parsed.lastRunAt).toBeUndefined();
    expect(parsed.id).toBe("job-worker");
  });

  it("skips migrations for consumer apps that are not schema owner", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    const consumerAppId = "app-consumer";
    writeJson(path.join(paprDir, "apps", consumerAppId, "data-sources.json"), {
      sources: [
        {
          id: "db:billing",
          type: "sqlite",
          dbId: "db-test",
          alias: "billing",
          dbPath: path.join(paprDir, "data", "databases", "billing", "data.db"),
        },
      ],
    });

    const { files } = await collectAppOpFiles(paprDir, consumerAppId);
    expect(files.some((file) => file.path.startsWith("databases/"))).toBe(false);
  });

  it("resolveWriterSyncedLocalPaths marks Jobs and owner migration roots", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    const paths = await resolveWriterSyncedLocalPaths(paprDir, appId);
    expect(paths).toContain(path.join("apps", appId));
    expect(paths).toContain(path.join("Jobs", "job-worker"));
    expect(paths).toContain(
      path.join("data", "databases", "billing", "migrations"),
    );
  });
});
