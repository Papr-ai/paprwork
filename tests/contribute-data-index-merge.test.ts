import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeContributeDataIndexesIntoRepo,
  mergeDatabasesJsonForContribute,
  mergeJobsJsonForContribute,
} from "../src/gateway/services/cloudSync/contributeDataIndexMerge.js";
import type { DatabasesRegistryFile } from "../src/gateway/services/DatabaseRegistryService.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("mergeJobsJsonForContribute", () => {
  it("upserts linked jobs and remaps fork app id to target app id", () => {
    const forkAppId = "fork-app";
    const targetAppId = "owner-app";
    const ownerJobs: JobRecord[] = [
      {
        id: "job-other",
        name: "Other",
        type: "python",
        status: "completed",
        appIds: ["other-app"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const contributorJobs: JobRecord[] = [
      {
        id: "job-new",
        name: "New scraper",
        type: "python",
        status: "pending",
        appIds: [forkAppId],
        command: `python3 $JOB_DIR/code/run.py --app ${forkAppId}`,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ];

    const merged = mergeJobsJsonForContribute(
      ownerJobs,
      contributorJobs,
      ["job-new"],
      forkAppId,
      targetAppId,
    );

    expect(merged).toHaveLength(2);
    const added = merged.find((job) => job.id === "job-new");
    expect(added?.appIds).toEqual([targetAppId]);
    expect(added?.command).toContain(targetAppId);
    expect(merged.find((job) => job.id === "job-other")).toBeDefined();
  });
});

describe("mergeDatabasesJsonForContribute", () => {
  it("merges registry slice with portable localPath", () => {
    const owner: DatabasesRegistryFile = {
      version: 1,
      databases: {
        "db-owner-only": {
          dbId: "db-owner-only",
          localPath: "/owner/path.db",
          tursoShortName: "d-owneronly",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const contributor: DatabasesRegistryFile = {
      version: 1,
      databases: {
        "db-new": {
          dbId: "db-new",
          localPath: "/contributor/private.db",
          tursoShortName: "d-new1234",
          isolation: "per-user",
          status: "active",
          ownerJobId: "job-new",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      },
    };

    const merged = mergeDatabasesJsonForContribute(owner, contributor, ["db-new"]);
    expect(Object.keys(merged.databases)).toEqual(["db-owner-only", "db-new"]);
    expect(merged.databases["db-new"]?.localPath).toBe("");
    expect(merged.databases["db-owner-only"]?.localPath).toBe("/owner/path.db");
  });
});

describe("mergeContributeDataIndexesIntoRepo", () => {
  it("writes jobs.json and databases.json into cloned owner repo", async () => {
    const forkAppId = "fork-app";
    const targetAppId = "owner-app";
    const repoDir = makeDir("papr-contrib-repo-");
    const contributorDir = makeDir("papr-contrib-local-");

    writeJson(path.join(repoDir, "data", "jobs.json"), [
      {
        id: "job-existing",
        name: "Existing",
        type: "python",
        status: "completed",
        appIds: [targetAppId],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    writeJson(path.join(repoDir, "data", "databases.json"), {
      version: 1,
      databases: {},
    });

    fs.mkdirSync(path.join(contributorDir, "apps", forkAppId), { recursive: true });
    writeJson(path.join(contributorDir, "apps", forkAppId, "data-sources.json"), {
      version: 1,
      sources: [{ jobId: "job-new", dbId: "db-new" }],
    });
    fs.mkdirSync(path.join(contributorDir, "Jobs", "job-new"), { recursive: true });
    writeJson(path.join(contributorDir, "Jobs", "job-new", "job.json"), {
      id: "job-new",
      dependsOn: [],
    });
    writeJson(path.join(contributorDir, "data", "jobs.json"), [
      {
        id: "job-new",
        name: "Contributor job",
        type: "python",
        status: "pending",
        appIds: [forkAppId],
        writeDbIds: ["db-new"],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    writeJson(path.join(contributorDir, "data", "databases.json"), {
      version: 1,
      databases: {
        "db-new": {
          dbId: "db-new",
          localPath: "/tmp/private.db",
          tursoShortName: "d-new1234",
          isolation: "shared",
          status: "active",
          ownerJobId: "job-new",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      },
    });

    const result = await mergeContributeDataIndexesIntoRepo({
      repoDir,
      contributorPaprDir: contributorDir,
      forkAppId,
      targetAppId,
    });

    expect(result.paths).toContain("data/jobs.json");
    expect(result.paths).toContain("data/databases.json");

    const jobs = JSON.parse(
      fs.readFileSync(path.join(repoDir, "data", "jobs.json"), "utf8"),
    ) as JobRecord[];
    expect(
      jobs.some((job) => job.id === "job-new" && job.appIds.includes(targetAppId)),
    ).toBe(true);

    const registry = JSON.parse(
      fs.readFileSync(path.join(repoDir, "data", "databases.json"), "utf8"),
    ) as DatabasesRegistryFile;
    expect(registry.databases["db-new"]?.localPath).toBe("");
  });
});
