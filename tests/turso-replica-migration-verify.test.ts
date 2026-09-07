import { describe, expect, it } from "vitest";
import { diffTableSets } from "../src/gateway/services/tursoReplica/tursoReplicaMigrationVerify.js";

describe("tursoReplicaMigrationVerify", () => {
  it("filterUserSchemaComparisonTables strips legacy sync-path tables", async () => {
    const { filterUserSchemaComparisonTables } = await import(
      "../src/gateway/services/legacyCdcArtifacts.js"
    );
    expect(
      filterUserSchemaComparisonTables([
        "campaigns",
        "turso_cdc",
        "turso_cdc_version",
        "_papr_sync_log",
      ]),
    ).toEqual(["campaigns"]);
  });

  it("diffTableSets ignores legacy sync-path tables", () => {
    const replica = [
      "campaigns",
      "replies",
      "turso_cdc",
      "turso_cdc_version",
      "__turso_internal_seq___turso_internal_autoincrement_turso_cdc",
    ];
    const cloud = ["campaigns", "replies"];

    const diff = diffTableSets(replica, cloud);
    expect(diff.schemaPaired).toBe(true);
    expect(diff.replicaOnlyTables).toEqual([]);
    expect(diff.cloudOnlyTables).toEqual([]);
  });

  it("diffTableSets detects schema drift when ledgers could still match", () => {
    const replica = ["action_log", "campaigns", "replies"];
    const cloud = ["action_log", "campaigns", "replies", "prospects"];

    const diff = diffTableSets(replica, cloud);
    expect(diff.schemaPaired).toBe(false);
    expect(diff.cloudOnlyTables).toEqual(["prospects"]);
    expect(diff.replicaOnlyTables).toEqual([]);
  });

  it("diffTableSets reports paired when table sets match", () => {
    const tables = ["action_log", "replies", "schema_migrations"];
    const diff = diffTableSets(tables, tables);
    expect(diff.schemaPaired).toBe(true);
    expect(diff.replicaOnlyTables).toEqual([]);
    expect(diff.cloudOnlyTables).toEqual([]);
  });
});
