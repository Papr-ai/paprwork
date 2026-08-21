import { describe, expect, it, vi } from "vitest";
import {
  buildPublishLayerReport,
  webReady,
} from "../src/gateway/services/cloudSync/webReady.js";

vi.mock("../src/gateway/services/syncV3/writerSyncStatus.js", () => ({
  isAppWriterSyncReady: vi.fn(),
}));

vi.mock("../src/gateway/services/tursoSyncStatus.js", () => ({
  buildTursoSyncItemsReport: vi.fn(),
}));

import { isAppWriterSyncReady } from "../src/gateway/services/syncV3/writerSyncStatus.js";
import { buildTursoSyncItemsReport } from "../src/gateway/services/tursoSyncStatus.js";

describe("webReady", () => {
  it("returns not ready when writer ops are pending", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({
      ready: false,
      detail: "2 writer op(s) pending upload",
    });

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("writer_pending");
  });

  it("returns ready when writer and turso sources are synced", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({ ready: true });

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

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(true);
  });

  it("treats empty linked databases as web-ready (no user tables)", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({ ready: true });

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

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(true);
  });

  it("blocks when turso source is pending", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({ ready: true });

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [
        {
          appId: "app-1",
          alias: "main",
          jobId: "job-1",
          status: "pending",
          localTableCount: 1,
          remoteTableCount: 1,
        },
      ],
      summary: {
        synced: 0,
        pending: 1,
        empty: 0,
        quarantined: 0,
        unavailable: 0,
        total: 1,
      },
    });

    const result = await webReady("app-1", "/tmp/papr");
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("turso_pending");
  });
});

describe("buildPublishLayerReport", () => {
  it("maps turso pending to not_web_ready", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({ ready: true });

    vi.mocked(buildTursoSyncItemsReport).mockResolvedValue({
      sources: [
        {
          appId: "app-1",
          alias: "main",
          jobId: "job-1",
          status: "pending",
          localTableCount: 1,
          remoteTableCount: 0,
        },
      ],
      summary: {
        synced: 0,
        pending: 1,
        empty: 0,
        quarantined: 0,
        unavailable: 0,
        total: 1,
      },
    });

    const report = await buildPublishLayerReport("app-1", {
      paprDir: "/tmp/papr",
    });
    expect(report.status).toBe("not_web_ready");
    expect(report.reason).toBe("turso_pending");
  });

  it("allows live publish when writer is still catching up", async () => {
    vi.mocked(isAppWriterSyncReady).mockResolvedValue({
      ready: false,
      detail: "1 writer op(s) pending upload",
    });

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

    const report = await buildPublishLayerReport("app-1", {
      paprDir: "/tmp/papr",
      publishLive: true,
    });
    expect(report.status).toBe("synced");
    expect(report.detail).toContain("writer sync is catching up");
  });
});
