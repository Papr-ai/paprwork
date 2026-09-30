import { describe, expect, test } from "vitest";

import {
  extractPrimaryTableFromRowSql,
  isPlatformTableName,
} from "../src/gateway/services/syncV3/logReplayRowSql.js";

describe("logReplayRowSql", () => {
  test("extractPrimaryTableFromRowSql parses INSERT UPDATE DELETE", () => {
    expect(
      extractPrimaryTableFromRowSql("INSERT INTO person_tags (id) VALUES (?)"),
    ).toBe("person_tags");
    expect(
      extractPrimaryTableFromRowSql("INSERT OR REPLACE INTO items (id) VALUES (1)"),
    ).toBe("items");
    expect(extractPrimaryTableFromRowSql("UPDATE metrics SET value = ?")).toBe(
      "metrics",
    );
    expect(extractPrimaryTableFromRowSql("DELETE FROM person_label WHERE id = ?")).toBe(
      "person_label",
    );
  });

  test("isPlatformTableName flags infra tables", () => {
    expect(isPlatformTableName("_papr_sync_log")).toBe(true);
    expect(isPlatformTableName("schema_migrations")).toBe(true);
    expect(isPlatformTableName("person_tags")).toBe(false);
  });
});
