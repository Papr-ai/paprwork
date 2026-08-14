import { describe, expect, it } from "vitest";
import {
  maxExecutableMigrationId,
  normalizeRequiredSchemaVersion,
  requiredSchemaVersionFromMigrationIds,
} from "../src/gateway/services/jobs/migrationLedgerPolicy.js";

describe("cloud app schema gate migration ids", () => {
  it("ignores baseline-only ledgers for requiredSchemaVersion", () => {
    expect(
      requiredSchemaVersionFromMigrationIds(["0001_baseline", "0001_baseline.sql"]),
    ).toBeNull();
    expect(maxExecutableMigrationId(["0001_baseline"])).toBeNull();
  });

  it("uses highest executable migration id", () => {
    expect(
      requiredSchemaVersionFromMigrationIds([
        "0001_baseline",
        "0002_social.sql",
        "0003_peers.sql",
      ]),
    ).toBe("0003_peers.sql");
  });

  it("normalizes legacy baseline-only app-meta values", () => {
    expect(normalizeRequiredSchemaVersion("0001_baseline")).toBeNull();
    expect(normalizeRequiredSchemaVersion("0001_baseline.sql")).toBeNull();
    expect(normalizeRequiredSchemaVersion("0002_init.sql")).toBe("0002_init.sql");
  });
});
