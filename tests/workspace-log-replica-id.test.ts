import { beforeEach, describe, expect, it } from "vitest";

import {
  getDatabaseRegistryService,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";
import { dbTursoDatabaseName } from "../src/gateway/services/tursoDatabaseNaming.js";
import type { TursoLinkedSource } from "../src/gateway/services/tursoLinkedSources.js";
import { resolveReplicaIdForLinkedSource } from "../src/gateway/services/syncV3/workspaceLogSync.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("resolveReplicaIdForLinkedSource", () => {
  useIsolatedPaprWorkspace("workspace-log-replica-id");

  beforeEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
  });

  it("uses registry tursoShortName instead of dbId-derived d- prefix", () => {
    const dbId = "db-5a670620";
    getDatabaseRegistryService().mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: {
          [dbId]: {
            dbId,
            localPath: "/tmp/analysis/data.db",
            tursoShortName: "j-387d656d",
            label: "analysis",
            ownerJobId: "387d656d-0000-4000-8000-000000000000",
            isolation: "per-user",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const linked: TursoLinkedSource = {
      alias: "analysis",
      dbPath: "/tmp/analysis/data.db",
      dbId,
      jobId: "387d656d-0000-4000-8000-000000000000",
      appId: "app-1",
    };

    expect(resolveReplicaIdForLinkedSource(linked)).toBe("j-387d656d");
    expect(dbTursoDatabaseName(dbId)).toBe("d-5a670620");
    expect(resolveReplicaIdForLinkedSource(linked)).not.toBe(
      dbTursoDatabaseName(dbId),
    );
  });

  it("falls back to job Turso name when only jobId is present", () => {
    const linked: TursoLinkedSource = {
      alias: "metrics",
      dbPath: "/tmp/metrics/data.db",
      jobId: "de1a89d8-1111-4222-8333-444455556666",
      appId: "app-2",
    };

    expect(resolveReplicaIdForLinkedSource(linked)).toBe("j-de1a89d8");
  });
});
