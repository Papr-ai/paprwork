import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { applyMigrationSchemaPayloadLocally } from "../src/gateway/services/syncV3/migrationSchemaLocal.js";

describe("migrationSchemaLocal idempotent replay", () => {
  test("applyMigrationSchemaPayloadLocally skips SQL when target table is gone", () => {
    let canUseBetterSqlite = false;
    try {
      const probe = new Database(":memory:");
      probe.close();
      canUseBetterSqlite = true;
    } catch {
      canUseBetterSqlite = false;
    }

    if (!canUseBetterSqlite) {
      return;
    }

    const db = new Database(":memory:");
    db.exec("CREATE TABLE person_label (id TEXT PRIMARY KEY, tag TEXT)");

    const applied = applyMigrationSchemaPayloadLocally(db, {
      appId: "app-1",
      migrationId: "0003_person_tags",
      statements: ["INSERT INTO person_tags (id, tag) VALUES ('1', 'a')"],
    });

    expect(applied).toBe(true);
    const rows = db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .all("0003_person_tags") as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    db.close();
  });
});
