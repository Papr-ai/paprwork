import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  lineageUsesSharedPrimaryDatabase,
  resolveSharedPrimaryTursoEntry,
} from "../src/gateway/services/sharedPrimaryTursoResolve.js";
import {
  loadSharedPrimaryTursoStore,
  resolveSharedPrimaryTursoStorePath,
} from "../src/gateway/services/sharedPrimaryTursoStore.js";
import type { CloudAppLineageFile } from "../src/core/types/cloudAppLineage.js";

const getPaprAppsRoot = vi.fn();
const getById = vi.fn();

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprAppsRoot: () => getPaprAppsRoot(),
  getPaprRoot: () => paprHome,
}));

let paprHome: string;
let appsRoot: string;

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({ getById }),
  tursoNameForRecord: (
    record: { dbId: string; isolation?: string },
    userId?: string,
  ) => {
    if (record.isolation === "per-user" && userId) {
      const uid8 = userId.replace(/-/g, "").slice(0, 8).toLowerCase();
      return `d-abc12345-u-${uid8}`;
    }
    return "d-abc12345";
  },
}));

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

describe("lineageUsesSharedPrimaryDatabase", () => {
  it("treats track without explicit policy as shared", () => {
    const lineage = trackLineage("owner-uuid");
    delete (lineage as { databasePolicy?: string }).databasePolicy;
    expect(lineageUsesSharedPrimaryDatabase(lineage)).toBe(true);
  });

  it("rejects forked policy", () => {
    const lineage = trackLineage("owner-uuid");
    lineage.databasePolicy = "forked";
    expect(lineageUsesSharedPrimaryDatabase(lineage)).toBe(false);
  });
});

describe("resolveSharedPrimaryTursoEntry", () => {
  beforeEach(async () => {
    paprHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-resolve-"));
    appsRoot = path.join(paprHome, "apps");
    await fs.mkdir(appsRoot, { recursive: true });
    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });
    getPaprAppsRoot.mockReturnValue(appsRoot);
    getById.mockReset();
  });

  afterEach(async () => {
    await fs.rm(paprHome, { recursive: true, force: true });
  });

  it("discovers mapping from lineage without writing a registry file", async () => {
    const appId = "local-collab-app";
    const appDir = path.join(appsRoot, appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "papr-cloud-lineage.json"),
      JSON.stringify(trackLineage("publisher-user-id")),
      "utf8",
    );
    await fs.writeFile(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({
        sources: [{ id: "s1", type: "sqlite", alias: "main", dbId: "db-abc", dbPath: "/x", tables: [], linkedAt: "" }],
      }),
      "utf8",
    );

    getById.mockReturnValue({
      dbId: "db-abc",
      isolation: "shared",
    });

    const entry = resolveSharedPrimaryTursoEntry("d-abc12345", paprHome);
    expect(entry).toMatchObject({
      namespaceId: "ns-publisher",
      slug: "metrics-app",
      publisherUserId: "publisher-user-id",
      localAppId: appId,
    });

    expect(loadSharedPrimaryTursoStore(paprHome).databases["d-abc12345"]).toBeUndefined();
    expect(resolveSharedPrimaryTursoStorePath(paprHome)).toContain(
      ".shared-primary-turso.json",
    );
  });

  it("returns null when no track app matches the turso short name", async () => {
    getById.mockReturnValue({
      dbId: "db-other",
      isolation: "shared",
    });

    expect(resolveSharedPrimaryTursoEntry("d-nomatch99", paprHome)).toBeNull();
  });
});
