import { describe, expect, it } from "vitest";
import { computeSchemaPayloadContentHash } from "../src/gateway/services/jobs/migrationContentHash.js";

describe("migrationContentHash", () => {
  it("matches memory canonical hash for statements payload", () => {
    const hash = computeSchemaPayloadContentHash({
      migrationId: "e2e_test_migration",
      ops: null,
      statements: [
        "CREATE TABLE IF NOT EXISTS e2e_migration_probe (id INTEGER PRIMARY KEY)",
      ],
    });
    expect(hash).toBe(
      "c4da7464e19b7121fb109862441844e422520672de3e2cdc98b7afc45ee3c992",
    );
  });

  it("matches memory canonical hash for ops payload", () => {
    const hash = computeSchemaPayloadContentHash({
      migrationId: "__schema_drift_heal__123",
      ops: [
        {
          kind: "add_column",
          table: "decks",
          column: "title",
          type: "TEXT",
        },
      ],
      statements: null,
    });
    expect(hash).toBe(
      "e192a5f77085dfb45bd99af49c1a95958dd794d022f74e5f50e9c8de9c743049",
    );
  });
});
