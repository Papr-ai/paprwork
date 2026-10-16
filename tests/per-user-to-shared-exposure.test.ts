import { describe, expect, it } from "vitest";
import {
  publicTablesAfterShare,
  takeSharedExposure,
} from "../src/gateway/services/cloudAppPerUserIsolation.js";

describe("per-user → shared exposure report", () => {
  it("lists user tables that stay public; skips private and engine tables", () => {
    expect(
      publicTablesAfterShare(
        ["Notes", "tags", "_papr_oplog", "turso_cdc", "sqlite_sequence", "schema_migrations", "people"],
        new Set(["people"]),
      ),
    ).toEqual(["notes", "tags"]);
  });

  it("nothing reported when every user table is private", () => {
    expect(publicTablesAfterShare(["people"], new Set(["people"]))).toEqual([]);
  });

  it("takeSharedExposure is read-once and empty by default", () => {
    expect(takeSharedExposure("no-such-app")).toBeUndefined();
  });
});
