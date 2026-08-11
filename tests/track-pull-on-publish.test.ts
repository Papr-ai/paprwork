import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCloudAppLineageFile } from "../src/core/utils/cloudAppLineage.js";
import type { CloudAppLineageFile } from "../src/core/types/cloudAppLineage.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";
import { decideTrackPullAction } from "../src/gateway/services/cloudSync/trackPullOnPublishLogic.js";
import { CloudAppTrackSyncService } from "../src/gateway/services/CloudAppTrackSyncService.js";

vi.mock("../src/gateway/services/cloudSync/trackUpstreamRevision.js", () => ({
  fetchPublishedAppRevision: vi.fn(),
}));

import { fetchPublishedAppRevision } from "../src/gateway/services/cloudSync/trackUpstreamRevision.js";

const APP_ID = "track-app-test-id";

function makeLineage(
  overrides: Partial<CloudAppLineageFile> = {},
): CloudAppLineageFile {
  return {
    schemaVersion: "1.1.0",
    lineageId: "lineage-1",
    mode: "track",
    source: {
      orgId: "org-1",
      namespaceId: "ns-1",
      userId: "user-1",
      appId: "source-app-1",
      slug: "demo-app",
    },
    installedAt: "2026-01-01T00:00:00.000Z",
    upstreamRevision: "rev-old",
    trackAutoPull: true,
    ...overrides,
  };
}

function writeTrackAppFixture(
  appsDir: string,
  lineage: CloudAppLineageFile,
): void {
  const appDir = join(appsDir, APP_ID);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, CLOUD_LINEAGE_FILENAME),
    serializeCloudAppLineageFile(lineage),
    "utf8",
  );
  writeFileSync(join(appDir, "index.html"), "<html>local</html>", "utf8");
}

describe("decideTrackPullAction", () => {
  it("skips non-track installs", () => {
    expect(
      decideTrackPullAction({
        mode: "fork",
        lineage: makeLineage({ mode: "fork" }),
        liveRevision: "rev-live",
      }),
    ).toEqual({ action: "skip", reason: "not_track" });
  });

  it("skips when auto-pull is disabled", () => {
    expect(
      decideTrackPullAction({
        mode: "track",
        lineage: makeLineage({ trackAutoPull: false }),
        liveRevision: "rev-live",
      }),
    ).toEqual({ action: "skip", reason: "auto_pull_disabled" });
  });

  it("skips when live revision is unavailable", () => {
    expect(
      decideTrackPullAction({
        mode: "track",
        lineage: makeLineage(),
        liveRevision: null,
      }),
    ).toEqual({ action: "skip", reason: "no_live_revision" });
  });

  it("skips when upstream already matches live revision", () => {
    expect(
      decideTrackPullAction({
        mode: "track",
        lineage: makeLineage({ upstreamRevision: "rev-live" }),
        liveRevision: "rev-live",
      }),
    ).toEqual({ action: "skip", reason: "same_revision" });
  });

  it("pulls when live revision differs from upstream", () => {
    expect(
      decideTrackPullAction({
        mode: "track",
        lineage: makeLineage({ upstreamRevision: "rev-old" }),
        liveRevision: "rev-new",
      }),
    ).toEqual({ action: "pull" });
  });

  it("pulls when upstream revision is missing (legacy install)", () => {
    expect(
      decideTrackPullAction({
        mode: "track",
        lineage: makeLineage({ upstreamRevision: undefined }),
        liveRevision: "rev-new",
      }),
    ).toEqual({ action: "pull" });
  });
});

describe("CloudAppTrackSyncService.pullTrackAppsOnPublish", () => {
  let appsDir: string;
  let service: CloudAppTrackSyncService;

  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "papr-track-pull-"));
    service = new CloudAppTrackSyncService(appsDir);
    vi.mocked(fetchPublishedAppRevision).mockReset();
  });

  afterEach(() => {
    rmSync(appsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("skips track app when live revision matches upstream", async () => {
    writeTrackAppFixture(
      appsDir,
      makeLineage({ upstreamRevision: "rev-same" }),
    );
    vi.mocked(fetchPublishedAppRevision).mockResolvedValue("rev-same");

    const syncSpy = vi.spyOn(service, "syncTrackApp");

    const results = await service.pullTrackAppsOnPublish();

    expect(results).toEqual([
      {
        appId: APP_ID,
        action: "skipped",
        upstreamRevision: "rev-same",
        liveRevision: "rev-same",
      },
    ]);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("calls syncTrackApp when publisher revision is newer", async () => {
    writeTrackAppFixture(
      appsDir,
      makeLineage({ upstreamRevision: "rev-old" }),
    );
    vi.mocked(fetchPublishedAppRevision).mockResolvedValue("rev-new");
    vi.spyOn(service, "syncTrackApp").mockResolvedValue({
      appId: APP_ID,
      updatedFiles: ["index.html"],
      conflictFiles: [],
      skippedFiles: [],
      lastSyncedAt: "2026-01-02T00:00:00.000Z",
      upstreamRevision: "rev-new",
    });

    const results = await service.pullTrackAppsOnPublish();

    expect(service.syncTrackApp).toHaveBeenCalledWith(APP_ID);
    expect(results).toEqual([
      {
        appId: APP_ID,
        action: "synced",
        upstreamRevision: "rev-new",
        liveRevision: "rev-new",
        updatedFiles: ["index.html"],
        conflictFiles: [],
      },
    ]);
  });

  it("records error when syncTrackApp throws", async () => {
    writeTrackAppFixture(
      appsDir,
      makeLineage({ upstreamRevision: "rev-old" }),
    );
    vi.mocked(fetchPublishedAppRevision).mockResolvedValue("rev-new");
    vi.spyOn(service, "syncTrackApp").mockRejectedValue(
      new Error("clone failed"),
    );

    const results = await service.pullTrackAppsOnPublish();

    expect(results).toEqual([
      {
        appId: APP_ID,
        action: "error",
        upstreamRevision: "rev-old",
        liveRevision: "rev-new",
        error: "clone failed",
      },
    ]);
  });
});
