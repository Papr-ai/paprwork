import { describe, expect, it, vi } from "vitest";
import {
  buildPublishLayerReport,
  webReady,
} from "../src/gateway/services/cloudSync/webReady.js";

vi.mock("../src/gateway/services/CloudSyncService.js", () => ({
  getCloudSyncService: vi.fn(),
}));

vi.mock("../src/gateway/services/tursoSyncStatus.js", () => ({
  buildTursoSyncItemsReport: vi.fn(),
}));

vi.mock("../src/gateway/services/cloudSync/postPushVerify.js", () => ({
  verifyAppPushConvergence: vi.fn(),
}));

vi.mock("../src/gateway/services/cloudSync/convergenceChecker.js", () => ({
  loadConvergenceStateForApp: vi.fn(),
}));

import { getCloudSyncService } from "../src/gateway/services/CloudSyncService.js";
import { buildTursoSyncItemsReport } from "../src/gateway/services/tursoSyncStatus.js";
import { verifyAppPushConvergence } from "../src/gateway/services/cloudSync/postPushVerify.js";
import { loadConvergenceStateForApp } from "../src/gateway/services/cloudSync/convergenceChecker.js";

describe("webReady", () => {
  it("returns not ready when git item is pending", async () => {
    vi.mocked(getCloudSyncService).mockReturnValue({
      getGitHubSyncItemsReport: () => ({
        workspace: [],
        apps: [
          {
            relativePath: "apps/app-1",
            status: "pending",
            lastSyncAt: null,
          },
        ],
        jobs: [],
        queuedPaths: [],
        summary: {
          synced: 0,
          pending: 1,
          outdated: 0,
          failed: 0,
          updatesAvailable: 0,
          total: 1,
        },
      }),
    } as never);

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [],
      summary: {
        synced: 0,
        pending: 0,
        empty: 0,
        quarantined: 0,
        unavailable: 0,
        total: 0,
      },
    });

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("git_pending");
  });

  it("returns ready when git, turso, verify, and convergence pass", async () => {
    vi.mocked(getCloudSyncService).mockReturnValue({
      getGitHubSyncItemsReport: () => ({
        workspace: [],
        apps: [
          {
            relativePath: "apps/app-1",
            status: "synced",
            lastSyncAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        jobs: [],
        queuedPaths: [],
        summary: {
          synced: 1,
          pending: 0,
          outdated: 0,
          failed: 0,
          updatesAvailable: 0,
          total: 1,
        },
      }),
    } as never);

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [
        {
          appId: "app-1",
          alias: "main",
          jobId: "job-1",
          status: "synced",
          localTableCount: 1,
          remoteTableCount: 1,
        },
      ],
      summary: {
        synced: 1,
        pending: 0,
        empty: 0,
        quarantined: 0,
        unavailable: 0,
        total: 1,
      },
    });

    vi.mocked(verifyAppPushConvergence).mockResolvedValue({
      ok: true,
      git: null,
      turso: { ok: true, sources: [], errors: [] },
      errors: [],
    });

    vi.mocked(loadConvergenceStateForApp).mockReturnValue(null);

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(true);
  });

  it("treats empty linked databases as web-ready (no user tables)", async () => {
    vi.mocked(getCloudSyncService).mockReturnValue({
      getGitHubSyncItemsReport: () => ({
        workspace: [],
        apps: [
          {
            relativePath: "apps/app-1",
            status: "synced",
            lastSyncAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        jobs: [],
        queuedPaths: [],
        summary: {
          synced: 1,
          pending: 0,
          outdated: 0,
          failed: 0,
          updatesAvailable: 0,
          total: 1,
        },
      }),
    } as never);

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [
        {
          appId: "app-1",
          alias: "model",
          jobId: "job-1",
          status: "empty",
          localTableCount: 0,
          remoteTableCount: 0,
        },
      ],
      summary: {
        synced: 0,
        pending: 0,
        empty: 1,
        quarantined: 0,
        unavailable: 0,
        total: 1,
      },
    });

    vi.mocked(verifyAppPushConvergence).mockResolvedValue({
      ok: true,
      git: null,
      turso: { ok: true, sources: [], errors: [] },
      errors: [],
    });

    vi.mocked(loadConvergenceStateForApp).mockReturnValue(null);

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(true);
  });
});

describe("buildPublishLayerReport", () => {
  it("maps convergence drift to drift status", async () => {
    vi.mocked(getCloudSyncService).mockReturnValue({
      getGitHubSyncItemsReport: () => ({
        workspace: [],
        apps: [
          {
            relativePath: "apps/app-1",
            status: "synced",
            lastSyncAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        jobs: [],
        queuedPaths: [],
        summary: {
          synced: 1,
          pending: 0,
          outdated: 0,
          failed: 0,
          updatesAvailable: 0,
          total: 1,
        },
      }),
    } as never);

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [],
      summary: {
        synced: 0,
        pending: 0,
        empty: 0,
        quarantined: 0,
        unavailable: 0,
        total: 0,
      },
    });

    vi.mocked(verifyAppPushConvergence).mockResolvedValue({
      ok: true,
      git: null,
      turso: { ok: true, sources: [], errors: [] },
      errors: [],
    });

    vi.mocked(loadConvergenceStateForApp).mockReturnValue({
      checkedAt: "2026-01-01T00:00:00.000Z",
      driftTables: ["items"],
    });

    const report = await buildPublishLayerReport("app-1", {
      paprDir: "/tmp/papr",
    });
    expect(report.status).toBe("drift");
    expect(report.detail).toContain("items");
  });
});
