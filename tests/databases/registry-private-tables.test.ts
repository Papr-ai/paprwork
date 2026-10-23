import { describe, expect, it } from "vitest";
import {
  getDatabaseRegistryService,
  normalizeTableName,
  privateTablesOf,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../../src/gateway/services/DatabaseRegistryService.js";

const rec = (dbId: string, extra: Record<string, unknown> = {}) => ({
  dbId, localPath: "", tursoShortName: dbId.replace("db-", "d-"), isolation: "shared",
  status: "active", syncMode: "replica",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

describe("registry privateTables", () => {
  it("defaults to all public", () => {
    expect(privateTablesOf(undefined).size).toBe(0);
    expect(privateTablesOf({}).size).toBe(0);
  });

  it("normalizes names and skips malformed entries", () => {
    expect(normalizeTableName(' "Meeting_Notes" ')).toBe("meeting_notes");
    expect(() => normalizeTableName("notes; drop")).toThrow();
    expect([...privateTablesOf({ privateTables: ["Notes", "bad name", "tags"] })].sort()).toEqual([
      "notes",
      "tags",
    ]);
  });

  it("survives the cloud registry merge (linked-databases.json)", () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    const reg = getDatabaseRegistryService();
    reg.mergeFromRegistryFile(
      JSON.stringify({ version: 1, databases: { "db-aaaa1111": rec("db-aaaa1111", { privateTables: ["notes"] }) } }),
    );
    expect(privateTablesOf(reg.getById("db-aaaa1111"))).toEqual(new Set(["notes"]));
  });

  it("newer cloud record can make a table public again", () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    const reg = getDatabaseRegistryService();
    reg.mergeFromRegistryFile(
      JSON.stringify({ version: 1, databases: { "db-aaaa1111": rec("db-aaaa1111", { privateTables: ["notes"] }) } }),
    );
    reg.mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: { "db-aaaa1111": rec("db-aaaa1111", { updatedAt: "2026-10-02T00:00:00.000Z" }) },
      }),
    );
    expect(privateTablesOf(reg.getById("db-aaaa1111")).size).toBe(0);
  });
});
