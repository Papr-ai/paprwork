import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql,
  hasPushCloudSyncScope,
  PUSH_CLOUD_SYNC_REQUIRES_SCOPE_ERROR,
} from "../src/gateway/services/CloudObservabilityService.js";
import {
  loadWorkspaceAppRegistry,
  normalizePerAppRepoRelativePath,
  sanitizeGitHubReportForAgents,
} from "../src/gateway/services/cloudSync/appWriterRepoObservability.js";
import type { GitHubSyncItemsReport } from "../src/gateway/services/cloudSync/syncItemStatus.js";

describe("assertReadOnlySql", () => {
  it("allows SELECT and WITH queries", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
    expect(() =>
      assertReadOnlySql("WITH cte AS (SELECT 1 AS x) SELECT * FROM cte"),
    ).not.toThrow();
  });

  it("allows PRAGMA and EXPLAIN", () => {
    expect(() => assertReadOnlySql("PRAGMA table_info(audits)")).not.toThrow();
    expect(() => assertReadOnlySql("EXPLAIN SELECT * FROM audits")).not.toThrow();
  });

  it("rejects writes and DDL", () => {
    expect(() => assertReadOnlySql("INSERT INTO t VALUES (1)")).toThrow(
      /read-only/i,
    );
    expect(() => assertReadOnlySql("DELETE FROM t")).toThrow(/read-only/i);
    expect(() => assertReadOnlySql("DROP TABLE t")).toThrow(/read-only/i);
  });

  it("rejects empty SQL", () => {
    expect(() => assertReadOnlySql("   ")).toThrow(/required/i);
  });
});

describe("hasPushCloudSyncScope", () => {
  it("accepts appId, jobId, alias, tursoDatabase, or tables", () => {
    expect(hasPushCloudSyncScope({ appId: "e32e573c-9de3-4dee-90ed-5f98627df0f5" })).toBe(
      true,
    );
    expect(hasPushCloudSyncScope({ jobId: "4fe2155a-c301-4281-aba6-96645c9faaec" })).toBe(
      true,
    );
    expect(hasPushCloudSyncScope({ alias: "todos" })).toBe(true);
    expect(hasPushCloudSyncScope({ tursoDatabase: "d-3d70b559" })).toBe(true);
    expect(hasPushCloudSyncScope({ tables: ["todos"] })).toBe(true);
  });

  it("rejects unscoped push", () => {
    expect(hasPushCloudSyncScope(undefined)).toBe(false);
    expect(hasPushCloudSyncScope({})).toBe(false);
    expect(hasPushCloudSyncScope({ targets: ["turso"] })).toBe(false);
    expect(PUSH_CLOUD_SYNC_REQUIRES_SCOPE_ERROR).toMatch(/not allowed/i);
  });
});

describe("normalizePerAppRepoRelativePath", () => {
  it("maps legacy namespace paths to per-app repo root paths", () => {
    const appId = "4fea25e9-5fba-4ce0-9ca9-fa24d6713486";
    expect(
      normalizePerAppRepoRelativePath(`apps/${appId}/backend/bundle.json`).path,
    ).toBe("backend/bundle.json");
    expect(normalizePerAppRepoRelativePath("dist/app.js", appId).path).toBe(
      "dist/app.js",
    );
  });
});

describe("sanitizeGitHubReportForAgents", () => {
  it("strips apps rows and recalculates summary", () => {
    const report: GitHubSyncItemsReport = {
      workspace: [],
      apps: [
        {
          id: "4fea25e9-5fba-4ce0-9ca9-fa24d6713486",
          kind: "app",
          label: "Leadership Sync",
          relativePath: "apps/4fea25e9-5fba-4ce0-9ca9-fa24d6713486",
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
    };
    const sanitized = sanitizeGitHubReportForAgents(report);
    expect(sanitized.apps).toEqual([]);
    expect(sanitized.appsOmitted).toBe(true);
    expect(sanitized.summary.total).toBe(0);
    expect(sanitized.appsOmittedReason).toMatch(/appWriterRepo/);
  });
});
