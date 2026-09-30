import { describe, expect, it } from "vitest";
import path from "path";
import os from "os";
import {
  isFlatLegacyResourcePath,
  scanLegacyPathHealth,
} from "../src/gateway/services/legacyPathHealthScan.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

describe("isFlatLegacyResourcePath", () => {
  const base = path.join(os.homedir(), "Papr");
  const activeHome = path.join(
    base,
    "orgs",
    "org1",
    "namespaces",
    "ns1",
  );

  it("detects flat Jobs folder outside active workspace", () => {
    const flatJob = path.join(base, "Jobs", "abc-123");
    expect(isFlatLegacyResourcePath(flatJob, base, activeHome)).toBe(true);
  });

  it("accepts namespace job folder", () => {
    const nsJob = path.join(activeHome, "Jobs", "abc-123");
    expect(isFlatLegacyResourcePath(nsJob, base, activeHome)).toBe(false);
  });
});

describe("scanLegacyPathHealth", () => {
  it("flags jobs with hardcoded Papr paths in command", async () => {
    const tempRoot = path.join(os.tmpdir(), `papr-health-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "o1", "namespaces", "n1");
    const jobsRoot = path.join(activeHome, "Jobs");
    const jobId = "job-hardcoded-1";
    const jobDir = path.join(jobsRoot, jobId);
    await import("fs/promises").then(async (fs) => {
      await fs.mkdir(jobDir, { recursive: true });
    });

    const job: JobRecord = {
      id: jobId,
      name: "LinkedIn Auth",
      type: "python",
      status: "pending",
      appIds: ["__standalone__"],
      command:
        "python3 code/auth.py --profile ~/Papr/Jobs/job-hardcoded-1/data/chrome-profile",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await scanLegacyPathHealth({
      jobs: [job],
      apps: [],
      jobsRoot,
      appsRoot: path.join(activeHome, "apps"),
      paprBase: tempRoot,
      activePaprHome: activeHome,
    });

    expect(result.jobIssueCount).toBe(1);
    expect(result.jobs[0]?.issues.some((i) => i.kind === "hardcoded_command_path")).toBe(
      true,
    );

    await import("fs/promises").then((fs) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    );
  });

  it("flags jobs in index whose folder is missing from active workspace", async () => {
    const tempRoot = path.join(os.tmpdir(), `papr-health-missing-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "o1", "namespaces", "n-active");
    const siblingHome = path.join(tempRoot, "orgs", "o1", "namespaces", "n-sibling");
    const jobId = "848ad049-d7c9-4b27-abe3-b9d9d1f5b199";
    const jobsRoot = path.join(activeHome, "Jobs");
    const siblingJobDir = path.join(siblingHome, "Jobs", jobId);

    await import("fs/promises").then(async (fs) => {
      await fs.mkdir(siblingJobDir, { recursive: true });
      await fs.mkdir(path.join(activeHome, "apps"), { recursive: true });
    });

    const job: JobRecord = {
      id: jobId,
      name: "Enricher",
      type: "python",
      status: "pending",
      appIds: ["app-1"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await scanLegacyPathHealth({
      jobs: [job],
      apps: [],
      jobsRoot,
      appsRoot: path.join(activeHome, "apps"),
      paprBase: tempRoot,
      activePaprHome: activeHome,
    });

    expect(result.jobIssueCount).toBe(1);
    expect(result.jobs[0]?.issues.some((i) => i.kind === "missing_job_folder")).toBe(
      true,
    );
    expect(
      result.jobs[0]?.issues.some((i) => i.kind === "resource_found_elsewhere"),
    ).toBe(true);

    await import("fs/promises").then((fs) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    );
  });

  it("flags app-linked jobs missing from active workspace", async () => {
    const tempRoot = path.join(os.tmpdir(), `papr-health-app-jobs-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "o1", "namespaces", "n1");
    const appId = "app-mfl-1";
    const jobId = "job-linked-1";
    const appPath = path.join(activeHome, "apps", appId);
    const jobsRoot = path.join(activeHome, "Jobs");

    await import("fs/promises").then(async (fs) => {
      await fs.mkdir(appPath, { recursive: true });
      await fs.writeFile(
        path.join(appPath, "index.html"),
        "<html></html>",
        "utf8",
      );
      await fs.writeFile(
        path.join(appPath, "data-sources.json"),
        JSON.stringify({
          sources: [{ id: "s1", type: "sqlite", alias: "main", jobId }],
        }),
        "utf8",
      );
      await fs.mkdir(path.join(activeHome, "data"), { recursive: true });
      await fs.writeFile(
        path.join(activeHome, "data", "jobs.json"),
        JSON.stringify([
          {
            id: jobId,
            name: "Enricher",
            type: "python",
            status: "pending",
            appIds: [appId],
          },
        ]),
        "utf8",
      );
    });

    const result = await scanLegacyPathHealth({
      jobs: [
        {
          id: jobId,
          name: "Enricher",
          type: "python",
          status: "pending",
          appIds: [appId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      apps: [{ id: appId, title: "MFL Reports" }],
      jobsRoot,
      appsRoot: path.join(activeHome, "apps"),
      paprBase: tempRoot,
      activePaprHome: activeHome,
    });

    expect(result.appIssueCount).toBe(1);
    expect(
      result.apps[0]?.issues.some((i) => i.kind === "missing_linked_job_folder"),
    ).toBe(true);

    await import("fs/promises").then((fs) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    );
  });

  it("does not flag active workspace dbPath when same job id exists in another namespace", async () => {
    const tempRoot = path.join(os.tmpdir(), `papr-health-dup-job-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "active-org", "namespaces", "active-ns");
    const staleHome = path.join(tempRoot, "orgs", "stale-org", "namespaces", "stale-ns");
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const jobId = "2cafb2e9-696b-42db-98fa-5d605977123c";
    const activeDbPath = path.join(activeHome, "Jobs", jobId, "data", "data.db");
    const staleDbPath = path.join(staleHome, "Jobs", jobId, "data", "data.db");
    const appPath = path.join(activeHome, "apps", appId);
    const jobsRoot = path.join(activeHome, "Jobs");

    await import("fs/promises").then(async (fs) => {
      await fs.mkdir(path.dirname(activeDbPath), { recursive: true });
      await fs.writeFile(activeDbPath, "", "utf8");
      await fs.mkdir(path.dirname(staleDbPath), { recursive: true });
      await fs.writeFile(staleDbPath, "", "utf8");
      await fs.mkdir(appPath, { recursive: true });
      await fs.writeFile(
        path.join(appPath, "data-sources.json"),
        JSON.stringify({
          sources: [
            {
              id: "s1",
              type: "sqlite",
              alias: "Daily Brief Generator",
              jobId,
              dbPath: activeDbPath,
            },
          ],
        }),
        "utf8",
      );
    });

    const result = await scanLegacyPathHealth({
      jobs: [],
      apps: [{ id: appId, title: "Home" }],
      jobsRoot,
      appsRoot: path.join(activeHome, "apps"),
      paprBase: tempRoot,
      activePaprHome: activeHome,
    });

    expect(result.appIssueCount).toBe(0);
    expect(result.apps).toHaveLength(0);

    await import("fs/promises").then((fs) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    );
  });
});
