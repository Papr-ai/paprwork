import { describe, expect, it } from "vitest";
import {
  assessReplicaBacklog,
  countLiveRows,
  formatBacklogHold,
  isBacklogHoldError,
} from "../../../src/gateway/services/tursoReplica/replicaBacklogGuard.js";

describe("replica backlog guard", () => {
  it("holds a churn backlog (papr-unit-economics: 5.3M changes for ~17K rows)", () => {
    const a = assessReplicaBacklog(5_312_899, 16_873);
    expect(a.hold).toBe(true);
    expect(Math.round(a.changesPerRow)).toBe(315);
  });

  it("lets a real bulk import through (about one change per row)", () => {
    expect(assessReplicaBacklog(600_000, 580_000).hold).toBe(false);
  });

  it("lets small backlogs through whatever the ratio", () => {
    expect(assessReplicaBacklog(200_000, 10).hold).toBe(false);
    expect(assessReplicaBacklog(73_141, 40_055).hold).toBe(false);
  });

  it("holds a large backlog whose rows were all deleted", () => {
    expect(assessReplicaBacklog(300_000, 0).hold).toBe(true);
  });

  it("counts only the database's own tables", async () => {
    const seen: string[] = [];
    const n = await countLiveRows(async (stmts) => {
      seen.push(...stmts.map((s) => s.sql));
      if (stmts[0].sql.includes("sqlite_master")) {
        return [{ rows: ["usage_orgs", "turso_cdc", "_papr_oplog", "sqlite_sequence", "usage_daily"].map((name) => ({ name })) }];
      }
      return stmts.map((s) => ({ rows: [{ n: s.sql.includes("usage_orgs") ? 1318 : 13237 }] }));
    });
    expect(n).toBe(14_555);
    expect(seen.some((s) => s.includes("turso_cdc"))).toBe(false);
  });

  it("explains the hold and names the likely job", () => {
    const msg = formatBacklogHold(assessReplicaBacklog(5_312_899, 16_873), ["Sync live credit usage"]);
    expect(isBacklogHoldError(msg)).toBe(true);
    expect(msg).toContain("5,312,899 pending changes for 16,873 rows");
    expect(msg).toContain('"Sync live credit usage"');
    expect(msg).toContain("accept_cloud");
  });
});
