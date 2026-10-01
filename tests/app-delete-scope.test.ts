import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  resolveAppDeleteScope,
  resolveDatabaseDeleteScope,
  resolveJobDeleteScope,
  sanitizeDeleteAppOptionsForScope,
  shouldBlockTursoDeleteForSharedPrimary,
  TEAM_SHARED_REGISTRY_DELETE_MESSAGE,
} from "../src/gateway/services/appDeleteScope.js";
import type { JobGraph } from "../src/gateway/services/jobs/types.js";
import { invalidatePaprUserIdCache } from "../src/gateway/utils/paprUserId.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";
import {
  getDatabaseRegistryService,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";

describe("appDeleteScope", () => {
  const workspace = useIsolatedPaprWorkspace("app-delete-scope");
  const appsRoot = () => path.join(workspace.paprHome, "apps");
  const appId = "app-collab-test";

  const previousUserId = process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;

  function setUserId(userId: string): void {
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = userId;
    invalidatePaprUserIdCache();
  }

  afterEach(() => {
    if (previousUserId === undefined) {
      delete process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID;
    } else {
      process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = previousUserId;
    }
    invalidatePaprUserIdCache();
  });

  function writeLineage(
    mode: "track" | "fork",
    publisherUserId: string,
    databasePolicy?: "shared" | "forked",
  ): void {
    const appDir = path.join(appsRoot(), appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, CLOUD_LINEAGE_FILENAME),
      JSON.stringify({
        schemaVersion: "1.2.0",
        lineageId: "lineage-test",
        mode,
        databasePolicy,
        source: {
          orgId: "org-pub",
          namespaceId: "ns-pub",
          userId: publisherUserId,
          appId: "publisher-app-id",
          slug: "team-dashboard",
        },
        installedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  }

  beforeEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
    fs.rmSync(path.join(appsRoot(), appId), { recursive: true, force: true });
  });

  async function writeCollaboratorSharedPrimaryFixture(input: {
    tursoShortName: string;
    dbId?: string;
  }): Promise<string> {
    const dbId = input.dbId ?? "db-block0100-0000-4000-8000-000000000001";
    writeLineage("track", "user-publisher", "shared");
    const appDir = path.join(appsRoot(), appId);
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({
        sources: [
          {
            id: "src-main",
            type: "sqlite",
            alias: "main",
            dbId,
            dbPath: path.join(workspace.paprHome, "data", "databases", "main", "data.db"),
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const dbPath = path.join(workspace.paprHome, "data", "databases", "main", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.alloc(1));
    const registry = getDatabaseRegistryService();
    await registry.register({
      dbId,
      localPath: dbPath,
      tursoShortName: input.tursoShortName,
      isolation: "shared",
    });
    return dbId;
  }

  it("collaborator track install is local uninstall only", async () => {
    setUserId("user-collaborator");
    writeLineage("track", "user-publisher", "shared");

    const scope = await resolveAppDeleteScope(appId, appsRoot(), false);
    expect(scope.localUninstallOnly).toBe(true);
    expect(scope.publisherSharedDeprecation).toBe(false);

    const safe = sanitizeDeleteAppOptionsForScope(scope, {
      unpublishFromCloud: true,
      deleteLinkedJobs: true,
      deleteTursoDatabases: true,
      deleteRegistryDbIds: ["db-1"],
      deleteRegistryTurso: true,
    });
    expect(safe).toEqual({
      unpublishFromCloud: false,
      deleteLinkedJobs: false,
      deleteTursoDatabases: false,
      deleteRegistryDbIds: [],
      deleteRegistryTurso: false,
    });
  });

  it("publisher published shared app gets deprecation flag", async () => {
    setUserId("user-publisher");
    writeLineage("track", "user-publisher", "shared");

    const scope = await resolveAppDeleteScope(appId, appsRoot(), true);
    expect(scope.localUninstallOnly).toBe(false);
    expect(scope.publisherSharedDeprecation).toBe(true);
    expect(scope.sourceSlug).toBe("team-dashboard");
  });

  it("blocks Turso delete on shared primary for non-publisher", async () => {
    setUserId("user-collaborator");
    await writeCollaboratorSharedPrimaryFixture({ tursoShortName: "d-shared01" });

    expect(
      shouldBlockTursoDeleteForSharedPrimary("d-shared01", workspace.paprHome),
    ).toBe(true);

    setUserId("user-publisher");
    expect(
      shouldBlockTursoDeleteForSharedPrimary("d-shared01", workspace.paprHome),
    ).toBe(false);
  });

  it("fork install by non-publisher is not local-only", async () => {
    setUserId("user-other");
    writeLineage("fork", "user-publisher", "forked");

    const scope = await resolveAppDeleteScope(appId, appsRoot(), false);
    expect(scope.localUninstallOnly).toBe(false);
  });

  it("job linked only to collaborator track app is local-only delete", async () => {
    setUserId("user-collaborator");
    writeLineage("track", "user-publisher", "shared");

    const graph: JobGraph = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      folders: {},
      appLinks: {
        [appId]: { name: "Team", jobIds: ["job-linked"] },
      },
      edges: [],
    };

    const scope = await resolveJobDeleteScope("job-linked", {
      graph,
      jobAppIds: [appId],
      appsRootDir: appsRoot(),
    });
    expect(scope.localOnly).toBe(true);
    expect(scope.blockDelete).toBe(false);
    expect(scope.linkedAppIds).toContain(appId);
  });

  it("job linked to publisher-owned app is not local-only", async () => {
    setUserId("user-publisher");
    writeLineage("track", "user-publisher", "shared");

    const graph: JobGraph = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      folders: {},
      appLinks: {
        [appId]: { name: "Team", jobIds: ["job-pub"] },
      },
      edges: [],
    };

    const scope = await resolveJobDeleteScope("job-pub", {
      graph,
      appsRootDir: appsRoot(),
    });
    expect(scope.localOnly).toBe(false);
  });

  it("database delete blocked for shared-primary non-publisher", async () => {
    setUserId("user-collaborator");
    await writeCollaboratorSharedPrimaryFixture({ tursoShortName: "d-block01" });

    const scope = await resolveDatabaseDeleteScope(
      "d-block01",
      [],
      appsRoot(),
      workspace.paprHome,
    );
    expect(scope.blockDelete).toBe(true);
    expect(scope.blockReason).toBe(TEAM_SHARED_REGISTRY_DELETE_MESSAGE);
  });
});
