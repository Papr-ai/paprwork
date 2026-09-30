import { describe, expect, it } from "vitest";
import {
  normalizeMigrationId,
  normalizeMigrationIdList,
} from "../src/gateway/services/jobs/migrationIdNormalize.js";

describe("migrationIdNormalize", () => {
  it("strips .sql suffix", () => {
    expect(normalizeMigrationId("0001_baseline.sql")).toBe("0001_baseline");
    expect(normalizeMigrationId("0004_repair.sql")).toBe("0004_repair");
  });

  it("dedupes overlapping ledger ids and skips baseline markers", () => {
    expect(
      normalizeMigrationIdList([
        "0001_baseline",
        "0001_baseline.sql",
        "0002_add_contact.sql",
      ]),
    ).toEqual(["0002_add_contact"]);
  });
});
