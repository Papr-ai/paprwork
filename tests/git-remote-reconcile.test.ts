import { describe, expect, it } from "vitest";
import {
  areCloudRuntimeMetadataOnlyChanges,
  categorizeWorkingTreePathsForRemoteMerge,
  classifyIncomingRemoteChanges,
  inferGitRemoteReviewState,
  isEphemeralLocalSyncStatePath,
  isNonRetryableCloudPushError,
  isCloudJobStatusWritebackSummary,
  isCloudRuntimeMetadataGitPath,
  parseGitNameOnlyOutput,
  parsePorcelainChangedPaths,
  type RunGitFn,
} from "../src/gateway/services/cloudSync/gitRemoteReconcile.js";

describe("isCloudRuntimeMetadataGitPath", () => {
  it("allows job.json runtime files", () => {
    expect(isCloudRuntimeMetadataGitPath("Jobs/1e57a7da/job.json")).toBe(true);
    expect(isCloudRuntimeMetadataGitPath("Jobs/abc-def/job.json")).toBe(true);
  });

  it("allows jobs index and repo head marker", () => {
    expect(isCloudRuntimeMetadataGitPath("data/jobs.json")).toBe(true);
    expect(isCloudRuntimeMetadataGitPath("data/cloud-repo-head.txt")).toBe(true);
    expect(
      isCloudRuntimeMetadataGitPath("apps/ca1ab3b1/.papr-cloud-revision"),
    ).toBe(true);
  });

  it("rejects app code and job source files", () => {
    expect(isCloudRuntimeMetadataGitPath("apps/ca1ab3b1/index.html")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("Jobs/1e57a7da/scraper.py")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("Jobs/1e57a7da/code/main.ts")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("data/databases.json")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("workspace/notes.md")).toBe(false);
  });
});

describe("areCloudRuntimeMetadataOnlyChanges", () => {
  it("returns true for cloud job writeback paths only", () => {
    expect(
      areCloudRuntimeMetadataOnlyChanges([
        "Jobs/abc/job.json",
        "data/jobs.json",
      ]),
    ).toBe(true);
  });

  it("returns false when any path is app or job code", () => {
    expect(
      areCloudRuntimeMetadataOnlyChanges([
        "Jobs/abc/job.json",
        "apps/demo/index.html",
      ]),
    ).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(areCloudRuntimeMetadataOnlyChanges([])).toBe(false);
  });
});

describe("parseGitNameOnlyOutput", () => {
  it("normalizes paths and drops blanks", () => {
    expect(
      parseGitNameOnlyOutput("Jobs/a/job.json\n\napps/b/index.html\n"),
    ).toEqual(["Jobs/a/job.json", "apps/b/index.html"]);
  });
});

describe("isNonRetryableCloudPushError", () => {
  it("does not retry owner-review push failures", () => {
    expect(
      isNonRetryableCloudPushError(
        "Remote git has newer commits — review updates before pushing local changes",
      ),
    ).toBe(true);
  });

  it("retries transient network failures", () => {
    expect(isNonRetryableCloudPushError("fetch failed: ECONNRESET")).toBe(false);
  });
});

describe("isCloudJobStatusWritebackSummary", () => {
  it("matches cloud job status commit lines", () => {
    const summary = [
      "9808dd10 cloud: update job 1e57a7da-fe6a-4c1e-87c3-53887b1f2230 status",
      "e0e4c717 cloud: update job 1e57a7da-fe6a-4c1e-87c3-53887b1f2230 status",
    ].join("\n");
    expect(isCloudJobStatusWritebackSummary(summary)).toBe(true);
  });

  it("rejects mixed commit types", () => {
    const summary = [
      "9808dd10 cloud: update job abc status",
      "a1b2c3d4 feat: update dashboard",
    ].join("\n");
    expect(isCloudJobStatusWritebackSummary(summary)).toBe(false);
  });
});

describe("inferGitRemoteReviewState", () => {
  it("treats metadata-only paths as automatic sync", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["Jobs/abc/job.json", "data/jobs.json"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: false, metadataSync: true });
  });

  it("requires review when app code is on remote", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["apps/demo/index.html"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });

  it("uses commit summary heuristic when paths are not loaded yet", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: [],
        gitUpdatesSummary:
          "9808dd10 cloud: update job 1e57a7da status\n7ece636c cloud: update job 1e57a7da status",
      }),
    ).toEqual({ requiresReview: false, metadataSync: true });
  });

  it("requires review when paths unknown and summary is not job status", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: [],
        gitUpdatesSummary: "abc1234 update app dashboard",
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });

  it("treats job-status summary as metadata when paths are non-code extras", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: [
          "Jobs/abc/job.json",
          "data/jobs.json",
          "data/cloud-repo-head.txt",
        ],
        gitUpdatesSummary:
          "9808dd10 cloud: update job 1e57a7da status\n7ece636c cloud: update job 1e57a7da status",
      }),
    ).toEqual({ requiresReview: false, metadataSync: true });
  });

  it("requires review when job-status summary includes app source paths", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["apps/demo/index.html", "Jobs/abc/job.json"],
        gitUpdatesSummary: "9808dd10 cloud: update job abc status",
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });
});

describe("classifyIncomingRemoteChanges", () => {
  it("uses three-dot diff so local app changes do not block metadata auto-merge", async () => {
    const calls: string[][] = [];
    const runGit: RunGitFn = async (args) => {
      calls.push([...args]);
      if (args[0] === "fetch") {
        return "";
      }
      if (args[0] === "rev-list" && args[1] === "--count") {
        return "3\n";
      }
      if (args[0] === "diff" && args.includes("HEAD...origin/main")) {
        return "Jobs/abc/job.json\ndata/jobs.json\n";
      }
      if (args[0] === "log") {
        return "9808dd10 cloud: update job abc status\n";
      }
      return "";
    };

    await expect(classifyIncomingRemoteChanges(runGit)).resolves.toBe(
      "runtime_metadata_only",
    );
    const diffCall = calls.find((args) => args[0] === "diff");
    expect(diffCall).toEqual(["diff", "--name-only", "HEAD...origin/main"]);
  });

  it("falls back to commit summary when remote path list is empty", async () => {
    const runGit: RunGitFn = async (args) => {
      if (args[0] === "fetch") {
        return "";
      }
      if (args[0] === "rev-list") {
        return "2\n";
      }
      if (args[0] === "diff") {
        return "\n";
      }
      if (args[0] === "log") {
        return "9808dd10 cloud: update job abc status\n";
      }
      return "";
    };

    await expect(classifyIncomingRemoteChanges(runGit)).resolves.toBe(
      "runtime_metadata_only",
    );
  });

  it("uses commit summary when paths include only metadata extras", async () => {
    const runGit: RunGitFn = async (args) => {
      if (args[0] === "fetch") {
        return "";
      }
      if (args[0] === "rev-list") {
        return "5\n";
      }
      if (args[0] === "diff") {
        return "Jobs/a/job.json\ndata/jobs.json\ndata/cloud-repo-head.txt\n";
      }
      if (args[0] === "log") {
        return [
          "9808dd10 cloud: update job a status",
          "e0e4c717 cloud: update job b status",
        ].join("\n");
      }
      return "";
    };

    await expect(classifyIncomingRemoteChanges(runGit)).resolves.toBe(
      "runtime_metadata_only",
    );
  });
});

describe("parsePorcelainChangedPaths", () => {
  it("extracts normalized paths from porcelain output", () => {
    const porcelain = [
      " M Jobs/a/job.json",
      "MM data/jobs.json",
      " M apps/demo/index.html",
    ].join("\n");
    expect(parsePorcelainChangedPaths(porcelain)).toEqual([
      "Jobs/a/job.json",
      "data/jobs.json",
      "apps/demo/index.html",
    ]);
  });

  it("preserves leading status space — must not trim full porcelain string", () => {
    const porcelain = " M Jobs/job-0/job.json\n M Jobs/job-1/job.json\n";
    expect(parsePorcelainChangedPaths(porcelain)).toEqual([
      "Jobs/job-0/job.json",
      "Jobs/job-1/job.json",
    ]);
  });
});

describe("categorizeWorkingTreePathsForRemoteMerge", () => {
  it("restores metadata and ephemeral paths, stashes app source", () => {
    const result = categorizeWorkingTreePathsForRemoteMerge([
      "Jobs/a/job.json",
      "data/jobs.json",
      "data/jobs.json.backup-123",
      "apps/demo/index.html",
      "data/.turso-convergence-state.json",
    ]);
    expect(result.restoreBeforeMerge).toEqual([
      "Jobs/a/job.json",
      "data/jobs.json",
      "data/jobs.json.backup-123",
      "data/.turso-convergence-state.json",
    ]);
    expect(result.stashBeforeMerge).toEqual(["apps/demo/index.html"]);
  });
});

describe("isEphemeralLocalSyncStatePath", () => {
  it("matches backup and turso state files", () => {
    expect(isEphemeralLocalSyncStatePath("data/jobs.json.backup-1700000")).toBe(
      true,
    );
    expect(isEphemeralLocalSyncStatePath("data/.turso-convergence-state.json")).toBe(
      true,
    );
    expect(isEphemeralLocalSyncStatePath("apps/demo/index.html")).toBe(false);
  });
});

describe("summarizeIncomingRemoteGitLog", () => {
  it("builds headline for mixed contrib merge and job status commits", async () => {
    const { summarizeIncomingRemoteGitLog } = await import(
      "../src/gateway/services/cloudSync/gitRemoteReconcile.js"
    );
    const summary = [
      "9808dd10 cloud: update job a status",
      "e0e4c717 cloud: update job b status",
      "abc1234 contrib: contrib/my-feature (#3)",
    ].join("\n");
    const result = summarizeIncomingRemoteGitLog(summary, [
      "apps/ca1ab3b1/backend/server.ts",
    ]);
    expect(result.headline).toBe(
      "1 contributed code merge + 2 cloud job status updates",
    );
    expect(result.hasAppSourcePaths).toBe(true);
  });
});
