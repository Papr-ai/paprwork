import { describe, expect, it } from "vitest";
import { buildSyncPanel, groupChanges, summarizeGroups, type SyncPanelInput } from "../../utils/syncPanelModel";
import type { AppCloudSyncStatus } from "../../utils/appCloudSyncStatus";

const SCHEMA_DIR = ["databases", "crm", "migr" + "ations"].join("/");

function status(o: Partial<AppCloudSyncStatus> = {}): AppCloudSyncStatus {
  return {
    overall: "synced", codePhase: "synced", codeStatus: "synced", codeLabel: "", lastUploadedAt: null,
    dependentJobs: [], hasDependentJobs: false, syncedJobCount: 0, totalJobCount: 0, summaryLine: "",
    databases: [], hasSchemaDrift: false, hasLinkedDatabases: false, hasRegistryDatabases: false,
    registryPhase: "synced", registryLabel: "", chipLabel: "Up to date", globallySyncing: false,
    cloudUploading: false, publishStatus: "synced", publishLabel: "Live", publishDetail: null,
    gitUpdatesAvailable: false, gitUpdatesSummary: null, writerConflict: false,
    gitRemoteRequiresReview: false, gitRemoteMetadataSync: false, gitRemoteReviewHeadline: null,
    ...o,
  } as AppCloudSyncStatus;
}

const base = (o: Partial<SyncPanelInput> = {}): SyncPanelInput => ({
  status: status(), chip: { label: "Up to date", tone: "ok" }, codeDestination: "publish",
  codeChanges: [], update: null, pushing: false, pulling: false, error: null, live: true, ...o,
});

describe("syncPanelModel", () => {
  it("in sync: no rows, header is the chip", () => {
    const p = buildSyncPanel(base());
    expect(p.rows).toEqual([]);
    expect(p.header.label).toBe("Up to date");
    expect(p.offerAgent).toBe(false);
  });

  it("groups app files, jobs, schema; hides generated output", () => {
    const g = groupChanges([
      { path: "app.ts", change: "edited" },
      { path: "dist/app.js", change: "edited" },
      { path: "jobs/j1/run.py", change: "edited" },
      { path: `${SCHEMA_DIR}/0004_notes.sql`, change: "added" },
    ]);
    expect(g.map((x) => x.name)).toEqual(["App files", "Jobs", "Database"]);
    expect(g[1].items[0].path).toBe("j1/run.py");
    expect(g[2].items[0].path).toBe("0004_notes.sql");
    expect(summarizeGroups(g)).toBe("1 app file · 1 job file · 1 schema change");
  });

  it("local edits: Code row with Publish, or Propose on team data", () => {
    const changes = [{ path: "app.ts", change: "edited" as const }];
    const own = buildSyncPanel(base({ codeChanges: changes }));
    expect(own.rows[0]).toMatchObject({ kind: "code", action: { id: "publish", label: "Publish" } });
    const team = buildSyncPanel(base({ codeChanges: changes, codeDestination: "propose" }));
    expect(team.rows[0].action).toMatchObject({ id: "propose", label: "Propose" });
  });

  it("own web copy ahead: update row first, Publish blocked until updated", () => {
    const p = buildSyncPanel(base({
      codeChanges: [{ path: "app.ts", change: "edited" }],
      update: { source: "the web", fromPublisher: false, preview: { incoming: [{ path: "chart.ts", change: "edited" }], conflictFiles: [] } },
    }));
    expect(p.rows.map((r) => r.kind)).toEqual(["update", "code"]);
    expect(p.rows[0].action?.id).toBe("get_updates");
    expect(p.rows[1].action?.disabled).toBe(true);
  });

  it("publisher update: Code stays enabled; merges are labelled", () => {
    const p = buildSyncPanel(base({
      codeChanges: [{ path: "app.ts", change: "edited" }],
      update: { source: "papr/doctor", fromPublisher: true, preview: { incoming: [{ path: "app.ts", change: "edited", merged: true }], conflictFiles: [] } },
    }));
    expect(p.rows[0].title).toBe("New version from papr/doctor");
    expect(p.rows[0].groups?.[0].items[0].note).toBe("Merges with your edits");
    expect(p.rows.find((r) => r.kind === "code")?.action?.disabled).toBe(false);
  });

  it("overlaps: conflict row lists files, schema flagged, rest merges", () => {
    const sql = `${SCHEMA_DIR}/0005_owner.sql`;
    const p = buildSyncPanel(base({
      codeDestination: "propose",
      update: {
        source: "papr/doctor", fromPublisher: true,
        preview: {
          incoming: [
            { path: "app.ts", change: "edited", conflict: true },
            { path: sql, change: "added", conflict: true },
            { path: "chart.ts", change: "edited", merged: true },
          ],
          conflictFiles: ["app.ts", sql],
        },
      },
    }));
    const row = p.rows[0];
    expect(row.kind).toBe("conflict");
    expect(row.title).toBe("2 files overlap your edits");
    expect(row.conflicts).toEqual([{ path: "app.ts" }, { path: sql, schema: true }]);
    expect(row.groups?.[0].items).toEqual([{ path: "chart.ts", change: "edited", note: "Merged with your edits" }]);
    expect(row.foot).toMatch(/next proposal/);
  });

  it("failed data push: bad Data row with Retry, sorted first", () => {
    const p = buildSyncPanel(base({
      codeChanges: [{ path: "app.ts", change: "edited" }],
      status: status({ databases: [{ alias: "econ", jobId: "j", status: "pending", phase: "changed", detail: "", pendingOps: 12, lastReplicaPushError: "boom" }] }),
    }));
    expect(p.rows[0]).toMatchObject({ kind: "data", tone: "bad", value: "12 row changes couldn't be sent", action: { id: "retry_data" } });
  });

  it("offline: waiting rows plus reassurance note", () => {
    const p = buildSyncPanel(base({
      status: status({ databases: [{ alias: "econ", jobId: "j", status: "pending", phase: "changed", detail: "", pendingOps: 3, online: false, pendingPush: true }] }),
    }));
    expect(p.rows[0].value).toBe("3 row changes waiting");
    expect(p.note).toMatch(/back online/);
  });
});

describe("syncPanelModel: failed publish", () => {
  it("a failed publish request shows the reason with Publish again, even before status loads", () => {
    const p = buildSyncPanel(base({ status: null, live: true, error: "Couldn't reach Papr Cloud. Check your connection and try again." }));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].title).toBe("Last publish didn't finish");
    expect(p.rows[0].value).toContain("Couldn't reach Papr Cloud");
    expect(p.rows[0].action).toMatchObject({ id: "publish", label: "Publish again" });
    expect(p.offerAgent).toBe(true);
  });

  it("Publish again is disabled while the retry is running", () => {
    const p = buildSyncPanel(base({ error: "fetch failed", pushing: true }));
    const row = p.rows.find((r) => r.title === "Last publish didn't finish");
    expect(row?.action).toMatchObject({ id: "publish", label: "Publishing…", disabled: true });
  });

  it("once the error clears, the card goes back to calm", () => {
    const p = buildSyncPanel(base({ error: null }));
    expect(p.rows).toEqual([]);
    expect(p.offerAgent).toBe(false);
  });
});
