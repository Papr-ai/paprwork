import { describe, expect, it } from "vitest";
import { PAPR_ROW_SYNC_COLUMNS } from "../src/core/types/jobMigrations.js";
import {
  missingRowSyncColumnNames,
  rowVersionMigrationSql,
  shouldApplyIncomingRow,
} from "../src/gateway/services/rowSyncColumns.js";
import type { TableColumn } from "../src/gateway/services/tursoSyncBridgeCore.js";

function columnsWithSync(): TableColumn[] {
  return [
    { name: "id", type: "INTEGER", primaryKey: true },
    { name: PAPR_ROW_SYNC_COLUMNS.createdAt, type: "TEXT", primaryKey: false },
    { name: PAPR_ROW_SYNC_COLUMNS.updatedAt, type: "TEXT", primaryKey: false },
    { name: PAPR_ROW_SYNC_COLUMNS.rowVersion, type: "INTEGER", primaryKey: false },
    { name: "title", type: "TEXT", primaryKey: false },
  ];
}

function row(
  version: number,
  updatedAt: string,
  title = "same",
): unknown[] {
  return [1, "2026-01-01", updatedAt, version, title];
}

describe("rowVersionMigrationSql", () => {
  it("includes all platform row sync columns and triggers", () => {
    const sql = rowVersionMigrationSql("contacts");
    expect(sql).toContain(PAPR_ROW_SYNC_COLUMNS.createdAt);
    expect(sql).toContain(PAPR_ROW_SYNC_COLUMNS.updatedAt);
    expect(sql).toContain(PAPR_ROW_SYNC_COLUMNS.rowVersion);
    expect(sql).toContain("AFTER INSERT ON \"contacts\"");
    expect(sql).toContain("AFTER UPDATE ON \"contacts\"");
  });

  it("detects missing _papr_* on remote even when local already has them", () => {
    const remoteOnlyUserCols: TableColumn[] = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "contact_name", type: "TEXT", primaryKey: false },
    ];
    expect(missingRowSyncColumnNames(remoteOnlyUserCols)).toEqual([
      PAPR_ROW_SYNC_COLUMNS.createdAt,
      PAPR_ROW_SYNC_COLUMNS.updatedAt,
      PAPR_ROW_SYNC_COLUMNS.rowVersion,
    ]);
    expect(missingRowSyncColumnNames([
      ...remoteOnlyUserCols,
      { name: PAPR_ROW_SYNC_COLUMNS.createdAt, type: "TEXT", primaryKey: false },
      { name: PAPR_ROW_SYNC_COLUMNS.updatedAt, type: "TEXT", primaryKey: false },
      { name: PAPR_ROW_SYNC_COLUMNS.rowVersion, type: "INTEGER", primaryKey: false },
    ])).toEqual([]);
  });
});

describe("shouldApplyIncomingRow", () => {
  const columns = columnsWithSync();

  it("applies when no existing row", () => {
    expect(shouldApplyIncomingRow(columns, null, row(2, "2026-02-01"))).toBe(true);
  });

  it("applies when incoming version is higher", () => {
    const existing = row(1, "2026-01-01");
    const incoming = row(2, "2026-01-01", "newer");
    expect(shouldApplyIncomingRow(columns, existing, incoming)).toBe(true);
  });

  it("skips when incoming version is lower", () => {
    const existing = row(3, "2026-01-01");
    const incoming = row(2, "2026-02-01", "stale");
    expect(shouldApplyIncomingRow(columns, existing, incoming)).toBe(false);
  });

  it("uses updated_at as tiebreaker when versions match", () => {
    const existing = row(2, "2026-01-01");
    const incoming = row(2, "2026-02-01", "tiebreak win");
    expect(shouldApplyIncomingRow(columns, existing, incoming)).toBe(true);

    const stale = row(2, "2025-12-01", "tiebreak lose");
    expect(shouldApplyIncomingRow(columns, existing, stale)).toBe(false);
  });

  it("applies when version columns are absent (legacy tables)", () => {
    const legacyCols: TableColumn[] = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "title", type: "TEXT", primaryKey: false },
    ];
    const existing = [1, "old"];
    const incoming = [1, "new"];
    expect(shouldApplyIncomingRow(legacyCols, existing, incoming)).toBe(true);
  });
});
