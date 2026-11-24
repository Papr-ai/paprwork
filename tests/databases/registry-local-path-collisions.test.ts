import { describe, expect, it } from "vitest";
import { findRegistryLocalPathCollisions } from "../../src/gateway/services/DatabaseRegistryService.js";

const rec = (dbId: string, localPath: string, status = "active") => ({
  dbId,
  localPath,
  tursoShortName: `d-${dbId.slice(3)}`,
  isolation: "shared" as const,
  status: status as "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("findRegistryLocalPathCollisions", () => {
  it("flags two active dbIds on one data.db and ignores tombstones", () => {
    const p = "/h/data/databases/linkedin-outreach-v2/data.db";
    const collisions = findRegistryLocalPathCollisions({
      version: 1,
      databases: {
        "db-2845224f": rec("db-2845224f", p),
        "db-59e5ad02": rec("db-59e5ad02", p),
        "db-dead0000": rec("db-dead0000", p, "tombstone"),
        "db-11112222": rec("db-11112222", "/h/data/databases/other/data.db"),
      },
    });
    expect([...collisions.values()]).toEqual([["db-2845224f", "db-59e5ad02"]]);
  });
});
