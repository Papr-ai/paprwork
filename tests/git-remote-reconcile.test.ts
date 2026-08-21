import { describe, expect, it } from "vitest";
import {
  areCloudRuntimeMetadataOnlyChanges,
  areLegacyJobRuntimeGitPathsOnly,
  areWorkspaceChatInfrastructureOnlyChanges,
  filterNamespaceReconcilePaths,
  formatDivergedGitHistoryHeadline,
  inferGitRemoteReviewState,
  isNamespaceAppGitPath,
  isGitHistoryDiverged,
  isLegacyJobRuntimeGitPath,
  isNonRetryableCloudPushError,
  isCloudJobStatusWritebackSummary,
  isCloudRuntimeMetadataGitPath,
  isCloudWorkspaceChatInfrastructureLine,
  isWorkspaceChatInfrastructureGitPath,
  parseGitNameOnlyOutput,
  summarizeIncomingRemoteGitLog,
} from "../src/gateway/services/cloudSync/namespaceGitReview.js";

describe("isCloudRuntimeMetadataGitPath (Sync V3 runtime off git)", () => {
  it("excludes job.json and jobs.json from auto-merge metadata paths", () => {
    expect(isCloudRuntimeMetadataGitPath("Jobs/1e57a7da/job.json")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("data/jobs.json")).toBe(false);
    expect(isCloudRuntimeMetadataGitPath("data/cloud-repo-head.txt")).toBe(true);
  });

  it("detects legacy job runtime path sets", () => {
    expect(isLegacyJobRuntimeGitPath("Jobs/abc/job.json")).toBe(true);
    expect(isLegacyJobRuntimeGitPath("data/jobs.json")).toBe(true);
    expect(isLegacyJobRuntimeGitPath("apps/demo/index.html")).toBe(false);
    expect(
      areLegacyJobRuntimeGitPathsOnly([
        "Jobs/a/job.json",
        "data/jobs.json",
      ]),
    ).toBe(true);
  });

  it("does not treat legacy job paths as metadata-only", () => {
    expect(
      areCloudRuntimeMetadataOnlyChanges([
        "Jobs/abc/job.json",
        "data/jobs.json",
      ]),
    ).toBe(false);
  });

  it("ignores legacy job status in inferGitRemoteReviewState", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["Jobs/abc/job.json", "data/jobs.json"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: false, metadataSync: false });
  });

  it("ignores stale namespace app paths on remote (writer owns app code)", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["apps/demo/index.html"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: false, metadataSync: false });
  });

  it("does not require review for workspace-chat-only remote paths", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: [
          "Jobs/workspace-chat/job.json",
          "Jobs/workspace-chat/code/.gitkeep",
          "data/jobs.json",
        ],
        gitUpdatesSummary:
          "228fddd cloud: scaffold workspace-chat job folder",
      }),
    ).toEqual({ requiresReview: false, metadataSync: true });
  });

  it("requires review for workspace-chat-only remote paths when history diverged", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        gitHistoryDiverged: true,
        remoteChangedPaths: [
          "Jobs/workspace-chat/job.json",
          "Jobs/workspace-chat/code/.gitkeep",
          "data/jobs.json",
        ],
        gitUpdatesSummary:
          "228fddd cloud: scaffold workspace-chat job folder",
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });
});

describe("git history divergence", () => {
  it("detects diverged history when both ahead and behind are positive", () => {
    expect(isGitHistoryDiverged(1, 3)).toBe(true);
    expect(isGitHistoryDiverged(0, 3)).toBe(false);
    expect(isGitHistoryDiverged(1, 0)).toBe(false);
    expect(isGitHistoryDiverged(0, 0)).toBe(false);
  });

  it("formats diverged history headline", () => {
    expect(formatDivergedGitHistoryHeadline(1, 3)).toBe(
      "Diverged git history (1 local commit, 3 cloud commits)",
    );
    expect(formatDivergedGitHistoryHeadline(2, 1)).toBe(
      "Diverged git history (2 local commits, 1 cloud commit)",
    );
  });
});

describe("workspace-chat cloud infrastructure", () => {
  it("treats workspace-chat job folder as cloud runtime metadata", () => {
    expect(isWorkspaceChatInfrastructureGitPath("Jobs/workspace-chat/job.json")).toBe(
      true,
    );
    expect(
      isWorkspaceChatInfrastructureGitPath(
        "Jobs/workspace-chat/migrations/0001_baseline.sql",
      ),
    ).toBe(true);
    expect(isCloudRuntimeMetadataGitPath("Jobs/workspace-chat/code/.gitkeep")).toBe(
      true,
    );
    expect(isCloudRuntimeMetadataGitPath("Jobs/other-job/scraper.py")).toBe(false);
  });

  it("detects workspace-chat-only remote diffs", () => {
    expect(
      areWorkspaceChatInfrastructureOnlyChanges([
        "Jobs/workspace-chat/job.json",
        "Jobs/workspace-chat/data/.gitkeep",
        "data/jobs.json",
      ]),
    ).toBe(true);
    expect(
      areWorkspaceChatInfrastructureOnlyChanges([
        "Jobs/workspace-chat/job.json",
        "apps/home/index.html",
      ]),
    ).toBe(false);
  });

  it("recognizes cloud scaffold commit messages", () => {
    expect(
      isCloudWorkspaceChatInfrastructureLine(
        "228fddd cloud: scaffold workspace-chat job folder",
      ),
    ).toBe(true);
    expect(
      isCloudWorkspaceChatInfrastructureLine(
        "83b5948 cloud: add workspace-chat agent job for Papr Web",
      ),
    ).toBe(true);
  });
});

describe("areCloudRuntimeMetadataOnlyChanges (Sync V3)", () => {
  it("returns false for legacy job runtime paths only", () => {
    expect(
      areCloudRuntimeMetadataOnlyChanges([
        "Jobs/abc/job.json",
        "data/jobs.json",
      ]),
    ).toBe(false);
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

describe("namespace app path filtering (Sync V3)", () => {
  it("detects stale apps/* monorepo paths", () => {
    expect(isNamespaceAppGitPath("apps/demo/index.html")).toBe(true);
    expect(isNamespaceAppGitPath("Jobs/demo/main.py")).toBe(false);
  });

  it("filters apps/* from namespace reconcile path lists", () => {
    expect(
      filterNamespaceReconcilePaths([
        "apps/demo/index.html",
        "Jobs/job-1/main.py",
        "data/jobs.json",
      ]),
    ).toEqual(["Jobs/job-1/main.py", "data/jobs.json"]);
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

describe("inferGitRemoteReviewState (Sync V3)", () => {
  it("ignores legacy job runtime paths without owner review", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["Jobs/abc/job.json", "data/jobs.json"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: false, metadataSync: false });
  });

  it("ignores stale namespace app paths (writer ops owns app code)", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["apps/demo/index.html"],
        gitUpdatesSummary: null,
      }),
    ).toEqual({ requiresReview: false, metadataSync: false });
  });

  it("ignores job-status summary when paths are not loaded yet", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: [],
        gitUpdatesSummary:
          "9808dd10 cloud: update job 1e57a7da status\n7ece636c cloud: update job 1e57a7da status",
      }),
    ).toEqual({ requiresReview: false, metadataSync: false });
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

  it("requires review when job-status summary includes job source paths", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["Jobs/abc/main.py", "Jobs/abc/job.json"],
        gitUpdatesSummary: "9808dd10 cloud: update job abc status",
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });

  it("requires review for contribution merges", () => {
    expect(
      inferGitRemoteReviewState({
        gitUpdatesAvailable: true,
        remoteChangedPaths: ["Jobs/contrib-feature/main.py"],
        gitUpdatesSummary: "abc1234 contrib: contrib/my-feature (#3)",
      }),
    ).toEqual({ requiresReview: true, metadataSync: false });
  });
});

describe("summarizeIncomingRemoteGitLog", () => {
  it("builds headline for mixed contrib merge and job status commits", () => {
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
    expect(result.hasAppSourcePaths).toBe(false);
  });

  it("flags job source paths in namespace git", () => {
    const result = summarizeIncomingRemoteGitLog("abc1234 cloud: job edit", [
      "Jobs/job-1/main.py",
    ]);
    expect(result.hasAppSourcePaths).toBe(true);
  });
});
