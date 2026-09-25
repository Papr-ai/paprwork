import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  resolveAppDeleteScope,
  sanitizeDeleteAppOptionsForScope,
  shouldBlockTursoDeleteForSharedPrimary,
} from "../src/gateway/services/appDeleteScope.js";
import { invalidatePaprUserIdCache } from "../src/gateway/utils/paprUserId.js";
import { CLOUD_LINEAGE_FILENAME } from "../src/gateway/services/CloudAppLineageService.js";
import {
  registerSharedPrimaryTursoEntries,
  SHARED_PRIMARY_TURSO_FILENAME,
} from "../src/gateway/services/sharedPrimaryTursoStore.js";

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
    fs.rmSync(path.join(appsRoot(), appId), { recursive: true, force: true });
  });

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

  it("blocks Turso delete on shared primary for non-publisher", () => {
    setUserId("user-collaborator");
    registerSharedPrimaryTursoEntries(
      [
        {
          tursoShortName: "d-shared01",
          namespaceId: "ns-pub",
          slug: "team-dashboard",
          publisherUserId: "user-publisher",
          localAppId: appId,
        },
      ],
      workspace.paprHome,
    );

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
});
