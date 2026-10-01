import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { serializeCloudAppLineageFile } from "../src/core/utils/cloudAppLineage.js";
import type { CloudAppLineageFile } from "../src/core/types/cloudAppLineage.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";

const installCloudAppLinkedResources = vi.fn();
const finalizePortableCloudAppResources = vi.fn();
const pullTrackSharedAppDatabase = vi.fn();
const bootstrapInstalledAppDatabases = vi.fn();

vi.mock("../src/gateway/services/cloudAppLinkedResourcesInstall.js", () => ({
  installCloudAppLinkedResources: (...args: unknown[]) =>
    installCloudAppLinkedResources(...args),
  finalizePortableCloudAppResources: (...args: unknown[]) =>
    finalizePortableCloudAppResources(...args),
}));

vi.mock("../src/gateway/services/cloudAppInstallBootstrap.js", () => ({
  pullTrackSharedAppDatabase: (...args: unknown[]) =>
    pullTrackSharedAppDatabase(...args),
  bootstrapInstalledAppDatabases: (...args: unknown[]) =>
    bootstrapInstalledAppDatabases(...args),
}));

let upstreamAppDir = "";
let upstreamRepoDir = "";

vi.mock("../src/gateway/services/cloudSync/cloudGitClone.js", () => ({
  cloneCloudAppSource: vi.fn().mockImplementation(async () => ({
    sourceDir: upstreamAppDir,
    repoDir: upstreamRepoDir,
    cleanup: vi.fn(),
  })),
}));

vi.mock("../src/gateway/services/CloudAppInstallService.js", () => ({
  getCloudAppInstallService: () => ({
    prepareInstall: vi.fn().mockResolvedValue({
      cloneUrl: "https://example.com/repo.git",
      token: "token",
      repoPath: "apps/demo",
      source: {
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "owner-1",
        appId: "source-app-1",
        slug: "demo-app",
      },
    }),
  }),
}));

vi.mock("../src/gateway/services/AppService.js", () => ({
  getAppService: () => ({
    writeAppFile: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock("../src/gateway/services/cloudSync/trackUpstreamRevision.js", () => ({
  fetchPublishedAppRevision: vi.fn().mockResolvedValue("rev-new"),
}));

import { CloudAppTrackSyncService } from "../src/gateway/services/CloudAppTrackSyncService.js";

const APP_ID = "track-shared-app";

function writeTrackApp(appsDir: string, lineage: CloudAppLineageFile): void {
  const appDir = join(appsDir, APP_ID);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, CLOUD_LINEAGE_FILENAME),
    serializeCloudAppLineageFile(lineage),
    "utf8",
  );
  writeFileSync(join(appDir, "index.html"), "<html>local</html>", "utf8");
}

describe("CloudAppTrackSyncService shared database track sync", () => {
  let appsDir: string;
  let service: CloudAppTrackSyncService;

  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "cloud-track-sync-"));
    upstreamRepoDir = mkdtempSync(join(tmpdir(), "cloud-track-upstream-repo-"));
    upstreamAppDir = join(upstreamRepoDir, "apps", "demo");
    mkdirSync(upstreamAppDir, { recursive: true });
    writeFileSync(join(upstreamAppDir, "index.html"), "<html>upstream</html>", "utf8");
    service = new CloudAppTrackSyncService(appsDir);
    installCloudAppLinkedResources.mockReset();
    finalizePortableCloudAppResources.mockReset();
    pullTrackSharedAppDatabase.mockReset();
    bootstrapInstalledAppDatabases.mockReset();
    installCloudAppLinkedResources.mockResolvedValue({
      copiedJobIds: [],
      registryDbIds: [],
    });
    finalizePortableCloudAppResources.mockResolvedValue(undefined);
    pullTrackSharedAppDatabase.mockResolvedValue({
      appId: APP_ID,
      linkedDbs: [],
      ready: true,
      needsSeed: false,
      errors: [],
      warnings: [],
    });
    bootstrapInstalledAppDatabases.mockResolvedValue({
      appId: APP_ID,
      linkedDbs: [],
      ready: true,
      needsSeed: false,
      errors: [],
      warnings: [],
    });
  });

  afterEach(() => {
    rmSync(appsDir, { recursive: true, force: true });
    rmSync(upstreamRepoDir, { recursive: true, force: true });
  });

  it("uses jobs_and_code linked sync and pull-only Turso for shared databasePolicy", async () => {
    writeTrackApp(appsDir, {
      schemaVersion: "1.2.0",
      lineageId: "lineage-1",
      mode: "track",
      databasePolicy: "shared",
      source: {
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "owner-1",
        appId: "source-app-1",
        slug: "demo-app",
      },
      installedAt: "2026-01-01T00:00:00.000Z",
      syncSnapshot: {},
    });

    await service.syncTrackApp(APP_ID);

    expect(installCloudAppLinkedResources).toHaveBeenCalledWith(
      expect.objectContaining({
        localAppId: APP_ID,
        syncScope: "jobs_and_code",
        skipReplicaPrep: true,
        installDbPolicy: "shared_primary",
      }),
    );
    expect(pullTrackSharedAppDatabase).toHaveBeenCalledWith(APP_ID);
    expect(bootstrapInstalledAppDatabases).not.toHaveBeenCalled();
  });

  it("runs full database bootstrap for forked track lineage", async () => {
    writeTrackApp(appsDir, {
      schemaVersion: "1.2.0",
      lineageId: "lineage-2",
      mode: "track",
      databasePolicy: "forked",
      source: {
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "owner-1",
        appId: "source-app-1",
        slug: "demo-app",
      },
      installedAt: "2026-01-01T00:00:00.000Z",
      syncSnapshot: {},
    });

    await service.syncTrackApp(APP_ID);

    expect(installCloudAppLinkedResources).toHaveBeenCalledWith(
      expect.not.objectContaining({
        syncScope: "jobs_and_code",
      }),
    );
    expect(bootstrapInstalledAppDatabases).toHaveBeenCalledWith(APP_ID);
    expect(pullTrackSharedAppDatabase).not.toHaveBeenCalled();
  });

  it("never reports platform-generated files as conflicts", async () => {
    // Collaborator copy differs from the install snapshot on generated files
    // only (rebuilt bundle, new schema version) plus one real edit.
    writeTrackApp(appsDir, {
      schemaVersion: "1.2.0",
      lineageId: "lineage-3",
      mode: "track",
      databasePolicy: "forked",
      source: {
        orgId: "org-1",
        namespaceId: "ns-1",
        userId: "owner-1",
        appId: "source-app-1",
        slug: "demo-app",
      },
      installedAt: "2026-01-01T00:00:00.000Z",
      syncSnapshot: {
        "index.html": "snap-index",
        "__papr__/app-meta.json": "snap-meta",
        "backend/bundle.json": "snap-bundle",
        "linked-databases.json": "snap-linked",
      },
    });
    const appDir = join(appsDir, APP_ID);
    mkdirSync(join(appDir, "__papr__"), { recursive: true });
    mkdirSync(join(appDir, "backend"), { recursive: true });
    writeFileSync(join(appDir, "__papr__", "app-meta.json"), '{"distRevision":"local"}', "utf8");
    writeFileSync(join(appDir, "backend", "bundle.json"), '{"local":true}', "utf8");
    writeFileSync(join(appDir, "linked-databases.json"), '{"db":"local-db"}', "utf8");

    mkdirSync(join(upstreamAppDir, "__papr__"), { recursive: true });
    mkdirSync(join(upstreamAppDir, "backend"), { recursive: true });
    writeFileSync(join(upstreamAppDir, "__papr__", "app-meta.json"), '{"distRevision":"up"}', "utf8");
    writeFileSync(join(upstreamAppDir, "backend", "bundle.json"), '{"up":true}', "utf8");
    writeFileSync(join(upstreamAppDir, "linked-databases.json"), '{"db":"publisher-db"}', "utf8");

    const result = await service.syncTrackApp(APP_ID);

    // The real edit still conflicts; generated files never do.
    expect(result.conflictFiles).toEqual(["index.html"]);
    expect(result.updatedFiles).toEqual(
      expect.arrayContaining(["__papr__/app-meta.json", "backend/bundle.json"]),
    );
    // Copy-specific wiring keeps the local ids.
    expect(result.skippedFiles).toContain("linked-databases.json");
    expect(result.updatedFiles).not.toContain("linked-databases.json");
  });
});
