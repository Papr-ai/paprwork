import { describe, expect, it } from "vitest";
import {
  parseJobMigrationManifest,
  rowVersionMigrationSql,
} from "../src/gateway/services/jobs/jobMigrationManifest.js";

describe("parseJobMigrationManifest", () => {
  it("parses a valid manifest with explicit ops", () => {
    const manifest = parseJobMigrationManifest({
      formatVersion: 1,
      schemaVersion: 2,
      migrations: [
        {
          id: "0002_add_contact.sql",
          description: "Add contact columns",
          ops: [
            {
              kind: "rename_column",
              table: "audits",
              from: "email",
              to: "contact_name",
            },
          ],
        },
      ],
    });
    expect(manifest?.schemaVersion).toBe(2);
    expect(manifest?.migrations[0]?.ops?.[0]?.kind).toBe("rename_column");
  });

  it("rejects unknown formatVersion", () => {
    expect(
      parseJobMigrationManifest({ formatVersion: 2, schemaVersion: 1, migrations: [] }),
    ).toBeNull();
  });
});

describe("rowVersionMigrationSql", () => {
  it("adds platform row sync columns with bump trigger", () => {
    const sql = rowVersionMigrationSql("audits");
    expect(sql).toContain("_papr_created_at");
    expect(sql).toContain("_papr_updated_at");
    expect(sql).toContain("_papr_row_version");
    expect(sql).toContain("AFTER UPDATE ON \"audits\"");
    expect(sql).toContain("_papr_sync_mute");
  });
});
