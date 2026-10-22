import { describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "./appDataSources.js";
import { previewLinkedDatabase, type LinkedDbRouter } from "./linkedDatabasePreview.js";

const src = (alias: string, dbId: string): AppDataSource =>
  ({ id: `${dbId}:${alias}`, type: "sqlite", alias, dbId, dbPath: `/db/${alias}.db`, tables: [] }) as unknown as AppDataSource;

function fakeRouter(): LinkedDbRouter & { query: ReturnType<typeof vi.fn> } {
  const col = { name: "id", type: "TEXT", pk: true };
  return {
    schema: vi.fn(async () => ({
      tables: [
        { table: "investors", columns: [col] },
        { table: "schema_migrations", columns: [col] },
        { table: "turso_cdc", columns: [col] },
      ],
    })),
    query: vi.fn(async (_a: string, _s: AppDataSource, sql: string) =>
      sql.includes("COUNT(*)") ? { rows: [{ cnt: 3 }] } : { rows: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    ),
  };
}

describe("previewLinkedDatabase", () => {
  it("lists user tables with counts and rows, hiding internal tables", async () => {
    const router = fakeRouter();
    const out = await previewLinkedDatabase({
      appId: "app-1", alias: "review", sources: [src("review", "db-1")], router,
    });
    expect(out.tables.map((t) => t.name)).toEqual(["investors"]);
    expect(out.tables[0]).toMatchObject({ rowCount: 3 });
    expect(out.tables[0].rows).toHaveLength(3);
    expect(out.selectedTable).toBe("investors");
    expect(out.dbPath).toBe("/db/review.db");
  });

  it("reads only through the router, with a bounded SELECT", async () => {
    const router = fakeRouter();
    await previewLinkedDatabase({ appId: "app-1", alias: "review", sources: [src("review", "db-1")], router });
    const sqls = router.query.mock.calls.map((c) => String(c[2]));
    expect(sqls.every((q) => q.startsWith("SELECT"))).toBe(true);
    expect(sqls.some((q) => q.includes("LIMIT 50"))).toBe(true);
  });

  it("rejects an alias that is not linked to the app", async () => {
    await expect(
      previewLinkedDatabase({ appId: "app-1", alias: "other", sources: [src("review", "db-1")], router: fakeRouter() }),
    ).rejects.toThrow(/not linked/);
  });

  it("falls back to the first table when tableName is unknown", async () => {
    const out = await previewLinkedDatabase({
      appId: "app-1", alias: "review", tableName: "nope", sources: [src("review", "db-1")], router: fakeRouter(),
    });
    expect(out.selectedTable).toBe("investors");
  });
});
