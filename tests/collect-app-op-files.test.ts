import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { dbIdFromPath } from "../src/gateway/services/DatabaseRegistryService.js";
import {
  collectAppOpFiles,
  MAX_OP_BATCH_CONTENT_BYTES,
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

    const dbDir = path.join(paprDir, "data", "databases", "billing");
    const dbPath = path.join(dbDir, "data.db");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(dbPath, "");
    fs.mkdirSync(path.join(dbDir, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(dbDir, "migrations", "0001_init.sql"),
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

  it("includes .papr-cloud-revision for apps.papr.ai cache busting", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);
    fs.writeFileSync(
      path.join(paprDir, "apps", appId, ".papr-cloud-revision"),
      "abc123revision\n",
    );
    fs.writeFileSync(
      path.join(paprDir, "apps", appId, ".secrets.env"),
      "KEY=secret\n",
    );

    const { files } = await collectAppOpFiles(paprDir, appId);
    const paths = files.map((file) => file.path);
    expect(paths).toContain(".papr-cloud-revision");
    expect(paths.some((p) => p.includes(".secrets"))).toBe(false);
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

  it("never reads app-local databases or their backups", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    // The shape that exhausted the heap: a SQLite file and its dated backups
    // sitting in the app folder, each read as a UTF-8 string before filtering.
    const appDir = path.join(paprDir, "apps", appId);
    const big = "x".repeat(1024 * 1024);
    fs.writeFileSync(path.join(appDir, "database.db"), big);
    fs.writeFileSync(path.join(appDir, "database.db-wal"), big);
    fs.writeFileSync(path.join(appDir, "database.db.bak.2026-08-21"), big);
    fs.mkdirSync(path.join(appDir, "backups"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "backups", "snapshot.json"), "{}");

    const { files, rejected } = await collectAppOpFiles(paprDir, appId);
    const paths = files.map((file) => file.path);

    expect(paths).toContain("metadata.json");
    expect(paths.some((p) => p.includes("database.db"))).toBe(false);
    expect(paths.some((p) => p.startsWith("backups/"))).toBe(false);
    // Excluded during the walk, so they are not even reported as rejected.
    expect(rejected).toEqual([]);
  });

  it("skips a file over the size limit without sending it", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    fs.writeFileSync(
      path.join(paprDir, "apps", appId, "huge.txt"),
      "a".repeat(11 * 1024 * 1024),
    );

    const { files, rejected } = await collectAppOpFiles(paprDir, appId);

    expect(files.some((file) => file.path === "huge.txt")).toBe(false);
    expect(rejected).toEqual([
      { path: "huge.txt", reason: expect.stringContaining("App Files") },
    ]);
  });

  it("defers files past the batch budget to a later flush", async () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    seedWorkspace(paprDir);

    // Eight 1MB assets against a 6MB budget: one op cannot carry them all.
    const appDir = path.join(paprDir, "apps", appId);
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(
        path.join(appDir, `asset-${index}.txt`),
        "a".repeat(1024 * 1024),
      );
    }

    const { files, deferred } = await collectAppOpFiles(paprDir, appId);

    const totalBytes = files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content ?? "", "utf8"),
      0,
    );
    expect(deferred).toBeGreaterThan(0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_OP_BATCH_CONTENT_BYTES);
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
