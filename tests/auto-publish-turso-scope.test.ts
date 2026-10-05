import { describe, expect, it } from "vitest";
import { buildTursoSyncItemsReportForApps } from "../src/gateway/services/tursoSyncStatus.js";

describe("post-publish auto-publish Turso report", () => {
  it("only probes the just-published apps, never the whole namespace", async () => {
    // Regression: tryAutoPublishCloudLinks built an unscoped report (every linked
    // DB) — 4-5 minutes per publish under load.
    const built: (string | undefined)[] = [];
    const fake = async (_root: string, appId?: string) => {
      built.push(appId);
      return {
        enabled: true,
        databaseMode: "per-job" as const,
        lastCheckedAt: "",
        error: null,
        sources: [{ appId } as never],
        summary: { synced: 1, pending: 0, empty: 0, unavailable: 0, quarantined: 0, total: 1 },
      };
    };
    const report = await buildTursoSyncItemsReportForApps("/apps", ["a", "b", "a"], undefined, fake);
    expect(built).toEqual(["a", "b"]);
    expect(report.sources).toHaveLength(2);
    expect(report.summary.total).toBe(2);
  });
});
