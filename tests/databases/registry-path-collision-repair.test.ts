import { describe, expect, it } from "vitest";
import { planRegistryCollisionRepair } from "../../src/gateway/services/repairRegistryPathCollisions.js";

const DATA = "/h/data";
const rec = (dbId: string, localPath: string, extra: Record<string, unknown> = {}) => ({
  dbId,
  localPath,
  tursoShortName: `d-${dbId.slice(3)}`,
  isolation: "shared" as const,
  status: "active" as const,
  syncMode: "replica" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

describe("planRegistryCollisionRepair", () => {
  const shared = `${DATA}/databases/linkedin-outreach-v2/data.db`;

  it("oldest keeps the folder; later replica moves to {slug}-{id}", () => {
    const plan = planRegistryCollisionRepair(
      {
        version: 1,
        databases: {
          "db-59e5ad02": rec("db-59e5ad02", shared, { createdAt: "2026-10-03T00:00:00.000Z" }),
          "db-2845224f": rec("db-2845224f", shared, { createdAt: "2026-09-07T00:00:00.000Z" }),
        },
      },
      DATA,
    );
    expect(plan.moves).toEqual([
      {
        dbId: "db-59e5ad02",
        from: shared,
        to: `${DATA}/databases/linkedin-outreach-v2-59e5ad02/data.db`,
        keptBy: "db-2845224f",
      },
    ]);
  });

  it("leaves duplicate records of one cloud database alone", () => {
    const plan = planRegistryCollisionRepair(
      {
        version: 1,
        databases: {
          "db-aaaa0001": rec("db-aaaa0001", shared),
          "db-aaaa0002": rec("db-aaaa0002", shared, { tursoShortName: "d-aaaa0001", createdAt: "2026-02-01T00:00:00.000Z" }),
        },
      },
      DATA,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/same cloud database/);
  });

  it("never moves a non-replica (its rows only exist in the shared file)", () => {
    const plan = planRegistryCollisionRepair(
      {
        version: 1,
        databases: {
          "db-bbbb0001": rec("db-bbbb0001", shared),
          "db-bbbb0002": rec("db-bbbb0002", shared, { syncMode: undefined, createdAt: "2026-02-01T00:00:00.000Z" }),
        },
      },
      DATA,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/not a replica/);
  });
});
