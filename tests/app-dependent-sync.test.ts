import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppDependentJobIds, resolveAppCloudSyncRelativePaths } from "../src/gateway/services/cloudSync/resolveAppDependentJobs.js";
import { buildGitHubSyncItemsReport } from "../src/gateway/services/cloudSync/syncItemStatus.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePaprDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "apps", "app-1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Jobs", "job-a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Jobs", "job-b"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  return dir;
}

describe("resolveAppDependentJobIds", () => {
  it("includes agent chat job from metadata.json when missing from jobs index", () => {
    const paprDir = makePaprDir();
    const agentChatJobId = "job-agent-chat";

    fs.mkdirSync(path.join(paprDir, "Jobs", agentChatJobId), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "apps", "app-1", "metadata.json"),
      JSON.stringify({
        appId: "app-1",
        title: "Demo",
        description: "Demo app",
        updatedAt: new Date().toISOString(),
        agentChatJobId,
      }),
    );

    expect(resolveAppDependentJobIds(paprDir, "app-1")).toEqual([agentChatJobId]);
  });

  it("includes jobs linked via data-sources and appIds", () => {
    const paprDir = makePaprDir();

    fs.writeFileSync(
      path.join(paprDir, "apps", "app-1", "data-sources.json"),
      JSON.stringify({
        primary: "audit",
        sources: [{ jobId: "job-a", alias: "audit", type: "sqlite" }],
      }),
    );

    fs.writeFileSync(
      path.join(paprDir, "data", "jobs.json"),
      JSON.stringify({
        jobs: [
          { id: "job-b", name: "Pipeline", appIds: ["app-1"] },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-b", "job.json"),
      JSON.stringify({
        id: "job-b",
        dependsOn: [{ jobId: "job-c", onStatus: "completed" }],
      }),
    );
    fs.mkdirSync(path.join(paprDir, "Jobs", "job-c"), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-c", "job.json"),
      JSON.stringify({ id: "job-c" }),
    );

    expect(resolveAppDependentJobIds(paprDir, "app-1")).toEqual([
      "job-a",
      "job-b",
      "job-c",
    ]);
  });
});

describe("resolveAppCloudSyncRelativePaths", () => {
  it("returns only the app folder (metadata off namespace git)", () => {
    const paprDir = makePaprDir();

    fs.writeFileSync(
      path.join(paprDir, "data", "jobs.json"),
      JSON.stringify({
        jobs: [{ id: "job-b", name: "App Agent Chat", appIds: ["app-1"] }],
      }),
    );
    fs.writeFileSync(
      path.join(paprDir, "Jobs", "job-b", "job.json"),
      JSON.stringify({ id: "job-b", type: "subagent" }),
    );

    const paths = resolveAppCloudSyncRelativePaths(paprDir, "app-1");
    expect(paths).toEqual([path.join("apps", "app-1")]);
    expect(paths).not.toContain(path.join("Jobs", "job-b"));
    expect(paths).not.toContain(path.join("data", "jobs.json"));
    expect(paths).not.toContain("data");
  });
});

describe("buildGitHubSyncItemsReport job dedupe", () => {
  it("does not duplicate Jobs and jobs paths on case-insensitive filesystems", () => {
    const paprDir = makePaprDir();
    fs.mkdirSync(path.join(paprDir, "Jobs", "job-a", "code"), { recursive: true });
    fs.writeFileSync(path.join(paprDir, "Jobs", "job-a", "job.json"), "{}");

    const report = buildGitHubSyncItemsReport({
      paprDir,
      syncedItems: {},
      queuedPaths: [],
      hasItemChanged: () => true,
    });

    expect(report.jobs).toHaveLength(2);
    expect(report.jobs.every((job) => job.relativePath.startsWith("Jobs/"))).toBe(
      true,
    );
  });
});
