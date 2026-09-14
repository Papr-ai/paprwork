import { describe, expect, it } from "vitest";
import {
  auditDatabasesRegistryFile,
  isRegistryPathPointingAtJobScratch,
} from "../src/gateway/services/registryJobScratchPathAudit.js";
import type { DatabasesRegistryFile } from "../src/gateway/services/DatabaseRegistryService.js";

describe("registryJobScratchPathAudit", () => {
  it("detects job scratch localPath", () => {
    expect(
      isRegistryPathPointingAtJobScratch(
        "/Papr/Jobs/abc/data/data.db",
      ),
    ).toBe(true);
    expect(
      isRegistryPathPointingAtJobScratch(
        "/Papr/data/databases/leads/data.db",
      ),
    ).toBe(false);
  });

  it("audits registry file entries", () => {
    const file: DatabasesRegistryFile = {
      version: 1,
      databases: {
        "db-good": {
          dbId: "db-good",
          localPath: "/ws/data/databases/app/data.db",
          tursoShortName: "d-good0001",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        "db-bad": {
          dbId: "db-bad",
          localPath: "/ws/Jobs/job-1/data/data.db",
          tursoShortName: "j-job1abcd",
          syncMode: "replica",
          ownerJobId: "job-1",
          isolation: "shared",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const findings = auditDatabasesRegistryFile(file, {
      workspaceRoot: "/ws",
      registryPath: "/ws/data/databases.json",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.dbId).toBe("db-bad");
    expect(findings[0]?.syncMode).toBe("replica");
  });
});
