import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_HOME_APP_ID,
  DEFAULT_HOME_BRIEFS_ALIAS,
  DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  mergeDailyBriefDataSource,
  writeHomeDailyBriefJobIdToAppDir,
} from "../src/gateway/services/defaultHomeBundle.js";
import { serializeDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import { homeLinkedSourcesInvariantsOk } from "../src/gateway/services/homeWorkspaceBootInvariants.js";
import { projectWorkspace } from "../src/gateway/services/goalsTasksProjection.js";

describe("homeWorkspaceBootInvariants", () => {
  let tmpDir: string;
  let appsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-boot-inv-"));
    appsDir = path.join(tmpDir, "apps");
    await fs.mkdir(path.join(appsDir, DEFAULT_HOME_APP_ID), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when data-sources.json is missing", async () => {
    const ok = await homeLinkedSourcesInvariantsOk({
      appsDir,
      jobExists: () => true,
    });
    expect(ok).toBe(false);
  });

  it("returns true when Daily Brief source is fully linked", async () => {
    const jobId = DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
    const registryDb = path.join(
      tmpDir,
      "data",
      "databases",
      "home-daily-briefs",
      "data.db",
    );
    await fs.mkdir(path.dirname(registryDb), { recursive: true });
    await fs.writeFile(registryDb, "");

    await writeHomeDailyBriefJobIdToAppDir(
      path.join(appsDir, DEFAULT_HOME_APP_ID),
      jobId,
    );

    const brief = mergeDailyBriefDataSource(
      undefined,
      jobId,
      registryDb,
      "db-test",
    );
    await fs.writeFile(
      path.join(appsDir, DEFAULT_HOME_APP_ID, "data-sources.json"),
      serializeDataSourcesFile({ sources: [brief] }),
      "utf8",
    );

    const ok = await homeLinkedSourcesInvariantsOk({
      appsDir,
      jobExists: (id) => id === jobId,
      resolveBriefReadTarget: async () => ({
        dbPath: registryDb,
        dbId: "db-test",
      }),
    });
    expect(ok).toBe(true);
    expect(brief.alias).toBe(DEFAULT_HOME_BRIEFS_ALIAS);
  });
});

describe("goalsTasksProjection fingerprint", () => {
  it("projectWorkspace is stable for the same input", () => {
    const input = {
      identity: "## Goals\n\n### G1 — Test\nStatus: active\n",
      archive: null,
      entities: {},
    };
    const a = projectWorkspace(input);
    const b = projectWorkspace(input);
    expect(a.goals.length).toBe(b.goals.length);
  });
});
