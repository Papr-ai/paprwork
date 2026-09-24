/**
 * System-assigned migration filenames (papr_db_create_migration).
 * Agent passes name + SQL; number and UTC timestamp are set automatically.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMigrationFileName,
  createMigrationFile,
  nextMigrationNumber,
  slugifyMigrationName,
} from "../src/gateway/services/jobs/migrationFileNaming.js";

const T = new Date(Date.UTC(2026, 8, 24, 22, 10, 11));

describe("buildMigrationFileName", () => {
  it("uses next number after highest existing file + UTC timestamp", () => {
    expect(
      buildMigrationFileName({
        existingFileNames: ["0001_init.sql", "0002_add_title.sql", "0002_vitals.sql"],
        name: "Add notes column",
        now: T,
      }),
    ).toBe("0003_20260924221011_add_notes_column.sql");
  });

  it("counts past already-timestamped files", () => {
    expect(nextMigrationNumber(["0001_init.sql", "0007_20260101000000_x.sql"])).toBe(8);
  });

  it("starts at 0001 on an empty folder", () => {
    expect(buildMigrationFileName({ existingFileNames: [], name: "init", now: T })).toBe(
      "0001_20260924221011_init.sql",
    );
  });

  it("slugifies names safely", () => {
    expect(slugifyMigrationName("  Add: Notes/Priority!.sql ")).toBe("add_notes_priority");
    expect(slugifyMigrationName("***")).toBe("migration");
  });

  it("two collaborators picking the same number still get different filenames", () => {
    const existing = ["0001_init.sql", "0002_add_title.sql"];
    const a = buildMigrationFileName({ existingFileNames: existing, name: "add_notes", now: T });
    const b = buildMigrationFileName({
      existingFileNames: existing,
      name: "add_notes",
      now: new Date(T.getTime() + 61_000),
    });
    expect(a.startsWith("0003_")).toBe(true);
    expect(b.startsWith("0003_")).toBe(true);
    expect(a).not.toBe(b);
    expect([b, a].sort()).toEqual([a, b]); // earlier timestamp sorts first
  });
});

describe("createMigrationFile", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mig-create-"));
    fs.mkdirSync(path.join(root, "migrations"));
    fs.writeFileSync(path.join(root, "migrations", "0001_init.sql"), "CREATE TABLE t(id INTEGER);");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the file with the assigned name and returns the migration id", async () => {
    const out = await createMigrationFile({
      migrationRoot: root,
      name: "add notes",
      sql: "ALTER TABLE t ADD COLUMN notes TEXT;",
      now: T,
    });
    expect(out.fileName).toBe("0002_20260924221011_add_notes.sql");
    expect(out.migrationId).toBe("0002_20260924221011_add_notes");
    expect(fs.readFileSync(out.fullPath, "utf8")).toContain("ADD COLUMN notes");
  });

  it("back-to-back creates get increasing numbers", async () => {
    const a = await createMigrationFile({ migrationRoot: root, name: "a", sql: "SELECT 1;", now: T });
    const b = await createMigrationFile({ migrationRoot: root, name: "b", sql: "SELECT 2;", now: T });
    expect(a.fileName).toBe("0002_20260924221011_a.sql");
    expect(b.fileName).toBe("0003_20260924221011_b.sql");
  });
});
