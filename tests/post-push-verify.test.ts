import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  assertAppPushVerified,
  verifyAppPushConvergence,
  verifyGitRemoteSha,
  verifyTursoConvergenceForApp,
} from "../src/gateway/services/cloudSync/postPushVerify.js";
import { publishedAppRevisionJsonUrl } from "../src/gateway/services/cloudSync/trackUpstreamRevision.js";

vi.mock("../src/gateway/services/tursoSyncStatus.js", () => ({
  buildTursoSyncItemsReport: vi.fn(),
}));

vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  discoverTursoLinkedSources: vi.fn(),
  linkedSourceSyncKey: vi.fn((source: { alias: string }) => source.alias),
}));

import { buildTursoSyncItemsReport } from "../src/gateway/services/tursoSyncStatus.js";
import { discoverTursoLinkedSources } from "../src/gateway/services/tursoLinkedSources.js";

describe("verifyGitRemoteSha", () => {
  it("passes when local HEAD matches origin/main", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123def456\n";
      }
      if (args[0] === "rev-parse" && args[1] === "origin/main") {
        return "abc123def456\n";
      }
      return "";
    };

    const result = await verifyGitRemoteSha(git);
    expect(result.ok).toBe(true);
    expect(result.localHead).toBe("abc123def456");
    expect(result.remoteHead).toBe("abc123def456");
    expect(calls[0]).toEqual(["fetch", "origin", "main"]);
  });

  it("fails when local HEAD differs from origin/main", async () => {
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "local111\n";
      }
      if (args[0] === "rev-parse" && args[1] === "origin/main") {
        return "remote222\n";
      }
      return "";
    };

    const result = await verifyGitRemoteSha(git);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("local111");
    expect(result.error).toContain("remote22");
  });
});

describe("verifyGitRemoteShaWithRetry", () => {
  it("retries transient HEAD mismatch then succeeds", async () => {
    const { verifyGitRemoteShaWithRetry } = await import(
      "../src/gateway/services/cloudSync/postPushVerify.js"
    );
    let attempts = 0;
    const git = async (args: string[]): Promise<string> => {
      if (args[0] !== "rev-parse") {
        return "";
      }
      attempts += 1;
      if (args[1] === "HEAD") {
        return attempts < 2 ? "local111\n" : "same\n";
      }
      if (args[1] === "origin/main") {
        return "same\n";
      }
      return "";
    };

    const result = await verifyGitRemoteShaWithRetry(git, {
      maxAttempts: 3,
      delayMs: 1,
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBeGreaterThan(1);
  });

  it("stops after max attempts on persistent mismatch", async () => {
    const { verifyGitRemoteShaWithRetry } = await import(
      "../src/gateway/services/cloudSync/postPushVerify.js"
    );
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "local111\n";
      }
      if (args[0] === "rev-parse" && args[1] === "origin/main") {
        return "remote222\n";
      }
      return "";
    };

    const result = await verifyGitRemoteShaWithRetry(git, {
      maxAttempts: 2,
      delayMs: 1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("verifyTursoConvergenceForApp", () => {
  beforeEach(() => {
    vi.mocked(buildTursoSyncItemsReport).mockReset();
    vi.mocked(discoverTursoLinkedSources).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when app has no linked Turso sources", async () => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [],
      summary: { synced: 0, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 0 },
    });

    const result = await verifyTursoConvergenceForApp(
      "nonexistent-app-id",
      "/tmp/empty-apps-root",
    );
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([]);
  });

  it("passes when linked sources are empty (no user tables)", async () => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [
        {
          appId: "app-1",
          jobId: "job-1",
          alias: "model",
          role: "linked",
          dbPath: "/tmp/data.db",
          tursoDatabase: "job-1",
          status: "empty",
          localTableCount: 0,
          remoteTableCount: 0,
        },
      ],
      summary: { synced: 0, pending: 0, empty: 1, unavailable: 0, quarantined: 0, total: 1 },
    });
    vi.mocked(discoverTursoLinkedSources).mockResolvedValue([]);

    const result = await verifyTursoConvergenceForApp("app-1", "/tmp/apps");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when linked sources are still pending", async () => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [
        {
          appId: "app-1",
          jobId: "job-1",
          alias: "metrics",
          role: "primary",
          dbPath: "/tmp/data.db",
          tursoDatabase: "job-1",
          status: "pending",
          localTableCount: 2,
          remoteTableCount: 1,
        },
      ],
      summary: { synced: 0, pending: 1, empty: 0, unavailable: 0, quarantined: 0, total: 1 },
    });
    vi.mocked(discoverTursoLinkedSources).mockResolvedValue([]);

    const result = await verifyTursoConvergenceForApp("app-1", "/tmp/apps");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("metrics");
    expect(result.errors[0]).toContain("pending");
  });
});

describe("verifyAppPushConvergence", () => {
  beforeEach(() => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [],
      summary: { synced: 0, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 0 },
    });
    vi.mocked(discoverTursoLinkedSources).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails when Turso sources are still pending", async () => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [
        {
          appId: "app-1",
          jobId: "job-1",
          alias: "metrics",
          role: "primary",
          dbPath: "/tmp/data.db",
          tursoDatabase: "job-1",
          status: "pending",
          localTableCount: 1,
          remoteTableCount: 0,
        },
      ],
      summary: { synced: 0, pending: 1, empty: 0, unavailable: 0, quarantined: 0, total: 1 },
    });

    const result = await verifyAppPushConvergence(
      "app-1",
      "/tmp/papr-no-git",
      undefined,
      { skipGit: true },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => entry.startsWith("Turso:"))).toBe(true);
    expect(result.git).toBeNull();
  });
});

describe("assertAppPushVerified", () => {
  beforeEach(() => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [],
      summary: { synced: 0, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 0 },
    });
    vi.mocked(discoverTursoLinkedSources).mockResolvedValue([]);
  });

  it("throws when convergence checks fail", async () => {
    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      enabled: true,
      databaseMode: "per-job",
      lastCheckedAt: new Date().toISOString(),
      error: null,
      sources: [
        {
          appId: "app-1",
          jobId: "job-1",
          alias: "metrics",
          role: "primary",
          dbPath: "/tmp/data.db",
          tursoDatabase: "job-1",
          status: "pending",
          localTableCount: 1,
          remoteTableCount: 0,
        },
      ],
      summary: { synced: 0, pending: 1, empty: 0, unavailable: 0, quarantined: 0, total: 1 },
    });

    await expect(
      assertAppPushVerified("app-1", "/tmp/papr-no-git"),
    ).rejects.toThrow("Post-push verify failed for app-1");
  });

  it("returns result when git and Turso are clean", async () => {
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "same\n";
      if (args[0] === "rev-parse" && args[1] === "origin/main") return "same\n";
      return "";
    };

    const result = await assertAppPushVerified("app-1", "/tmp/papr-no-git", git);
    expect(result.ok).toBe(true);
  });
});

describe("publishedAppRevisionJsonUrl", () => {
  it("builds apps.papr.ai revision JSON path", () => {
    expect(
      publishedAppRevisionJsonUrl("ns-1", "my-app"),
    ).toBe("https://apps.papr.ai/ns-1/my-app/__papr__/app-revision.json");
  });
});
