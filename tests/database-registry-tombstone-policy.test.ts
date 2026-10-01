import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertMayTombstoneDatabaseRecord,
  sanitizeDatabasesRegistryForCloudExport,
} from "../src/gateway/services/databaseRegistryTombstonePolicy.js";
import { TEAM_SHARED_REGISTRY_DELETE_MESSAGE } from "../src/gateway/services/appDeleteScope.js";
import type { DatabaseRecord } from "../src/gateway/services/DatabaseRegistryService.js";
import type { CloudAppLineageFile } from "../src/core/types/cloudAppLineage.js";

const getPaprAppsRoot = vi.fn();
const getById = vi.fn();

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprAppsRoot: () => getPaprAppsRoot(),
  getPaprRoot: () => paprHome,
}));

vi.mock("../src/gateway/utils/paprUserId.js", () => ({
  getPaprUserId: () => "collaborator-user-id",
}));

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({ getById }),
  tursoNameForRecord: () => "d-publisherseg",
}));

let paprHome: string;
let appsRoot: string;

function trackLineage(publisherUserId: string): CloudAppLineageFile {
  return {
    schemaVersion: "1.2.0",
    lineageId: "lineage-1",
    mode: "track",
    databasePolicy: "shared",
    installedAt: new Date().toISOString(),
    source: {
      orgId: "org-1",
      namespaceId: "ns-publisher",
      userId: publisherUserId,
      appId: "publisher-app-id",
      slug: "metrics-app",
    },
  };
}

function activeRecord(tursoShortName: string): DatabaseRecord {
  return {
    dbId: "db-1",
    localPath: "/Papr/data/databases/metrics/data.db",
    tursoShortName,
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

describe("databaseRegistryTombstonePolicy", () => {
  beforeEach(async () => {
    paprHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-tombstone-"));
    appsRoot = path.join(paprHome, "apps");
    await fs.mkdir(appsRoot, { recursive: true });
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });
    getPaprAppsRoot.mockReturnValue(appsRoot);

    const localAppId = "local-track-app";
    await fs.mkdir(path.join(appsRoot, localAppId), { recursive: true });
    await fs.writeFile(
      path.join(appsRoot, localAppId, "papr-cloud-lineage.json"),
      JSON.stringify(trackLineage("publisher-user-id")),
    );
    await fs.writeFile(
      path.join(appsRoot, localAppId, "data-sources.json"),
      JSON.stringify({
        sources: [{ id: "primary", type: "sqlite", alias: "primary", dbId: "db-1" }],
      }),
    );

    getById.mockImplementation((id: string) =>
      id === "db-1" ? activeRecord("d-publisherseg") : undefined,
    );
  });

  afterEach(async () => {
    await fs.rm(paprHome, { recursive: true, force: true });
  });

  it("blocks tombstone for publisher shared-primary segment", () => {
    expect(() => assertMayTombstoneDatabaseRecord(activeRecord("d-publisherseg"))).toThrow(
      TEAM_SHARED_REGISTRY_DELETE_MESSAGE,
    );
  });

  it("strips unauthorized tombstones from cloud export payload", () => {
    const { registry, strippedDbIds } = sanitizeDatabasesRegistryForCloudExport({
      version: 1,
      databases: {
        "db-1": { ...activeRecord("d-publisherseg"), status: "tombstone" },
      },
    });
    expect(strippedDbIds).toEqual(["db-1"]);
    expect(registry.databases["db-1"]?.status).toBe("active");
  });

  it("allows tombstone for caller-owned per-user copy", () => {
    const perUser = activeRecord("d-publisherseg-u-collabo");
    expect(() => assertMayTombstoneDatabaseRecord(perUser)).not.toThrow();
  });
});
