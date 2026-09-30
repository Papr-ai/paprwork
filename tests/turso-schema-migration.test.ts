import { describe, expect, it } from "vitest";
import {
  planSchemaMigration,
  type SchemaMigrationPlan,
} from "../src/gateway/services/tursoSchemaMigration.js";
import type { TableColumn } from "../src/gateway/services/tursoSyncBridgeCore.js";
import { PAPR_ROW_SYNC_COLUMNS } from "../src/core/types/jobMigrations.js";

function col(
  name: string,
  type = "TEXT",
  primaryKey = false,
): TableColumn {
  return { name, type, primaryKey };
}

function stepKinds(plan: SchemaMigrationPlan): string[] {
  return plan.steps.map((step) => step.kind);
}

describe("planSchemaMigration", () => {
  it("plans ADD COLUMN for new local columns", () => {
    const current = [col("id", "INTEGER", true), col("name")];
    const desired = [
      col("id", "INTEGER", true),
      col("name"),
      col("contact_name"),
      col("contact_email"),
    ];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(stepKinds(plan)).toEqual(["add_column", "add_column"]);
    expect(
      plan.steps.filter((s) => s.kind === "add_column").map((s) => s.column.name),
    ).toEqual(["contact_name", "contact_email"]);
  });

  it("plans ADD COLUMN for user columns and platform _papr_* when both missing on remote", () => {
    const current = [col("id", "INTEGER", true), col("title")];
    const desired = [
      col("id", "INTEGER", true),
      col("title"),
      col("contact_name"),
      col(PAPR_ROW_SYNC_COLUMNS.createdAt),
      col(PAPR_ROW_SYNC_COLUMNS.updatedAt),
      col(PAPR_ROW_SYNC_COLUMNS.rowVersion, "INTEGER"),
    ];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(
      plan.steps.filter((s) => s.kind === "add_column").map((s) => s.column.name),
    ).toEqual([
      "contact_name",
      PAPR_ROW_SYNC_COLUMNS.createdAt,
      PAPR_ROW_SYNC_COLUMNS.updatedAt,
      PAPR_ROW_SYNC_COLUMNS.rowVersion,
    ]);
  });

  it("plans DROP COLUMN for removed columns", () => {
    const current = [col("id", "INTEGER", true), col("legacy_field")];
    const desired = [col("id", "INTEGER", true)];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(stepKinds(plan)).toEqual(["drop_column"]);
  });

  it("detects rename when one column removed and one added with same shape", () => {
    const current = [col("id", "INTEGER", true), col("old_name")];
    const desired = [col("id", "INTEGER", true), col("new_name")];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(plan.steps).toEqual([
      { kind: "rename_column", from: "old_name", to: "new_name" },
    ]);
  });

  it("requires rebuild for type changes on existing columns", () => {
    const current = [col("id", "INTEGER", true), col("score", "TEXT")];
    const desired = [col("id", "INTEGER", true), col("score", "INTEGER")];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(true);
    expect(plan.rebuildReason).toContain("score");
  });

  it("requires rebuild for primary-key changes", () => {
    const current = [col("id", "INTEGER", true), col("code")];
    const desired = [col("id", "INTEGER", true), col("code", "TEXT", true)];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(true);
  });

  it("never plans DROP COLUMN for platform _papr_* columns", () => {
    const current = [
      col("id", "INTEGER", true),
      col("name"),
      col(PAPR_ROW_SYNC_COLUMNS.createdAt),
      col(PAPR_ROW_SYNC_COLUMNS.updatedAt),
      col(PAPR_ROW_SYNC_COLUMNS.rowVersion, "INTEGER"),
    ];
    const desired = [col("id", "INTEGER", true), col("name")];

    const plan = planSchemaMigration(current, desired);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(stepKinds(plan)).toEqual([]);
  });

  it("returns empty plan when schemas already match", () => {
    const columns = [col("id", "INTEGER", true), col("name")];
    const plan = planSchemaMigration(columns, columns);
    expect(plan.requiresTableRebuild).toBe(false);
    expect(plan.steps).toEqual([]);
  });
});
