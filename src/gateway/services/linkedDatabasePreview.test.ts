import { describe, expect, it, vi } from "vitest";
import type { AppDataSource } from "./appDataSources.js";
import { previewLinkedDatabase, type LinkedDbRouter } from "./linkedDatabasePreview.js";

const src = (alias: string, dbId: string): AppDataSource =>
  ({ id: `${dbId}:${alias}`, type: "sqlite", alias, dbId, dbPath: `/db/${alias}.db`, tables: [] }) as unknown as AppDataSource;

function fakeRouter(): LinkedDbRouter & { query: ReturnType<typeof vi.fn> } {
  const id = { name: "id", type: "INTEGER", pk: true };
  const name = { name: "name", type: "TEXT", pk: false };
  return {
    schema: vi.fn(async () => ({
      tables: [
        { table: "investors", columns: [id, name] },
        { table: "notes", columns: [name] },
        { table: "schema_migrations", columns: [id] },
        { table: "turso_cdc", columns: [id] },
      ],
    })),
    query: vi.fn(async (_a: string, _s: AppDataSource, sql: string) =>
      sql.includes("COUNT(*)") ? { rows: [{ cnt: 250 }] } : { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ),
  };
}

const base = { appId: "app-1", alias: "review", sources: [src("review", "db-1")] };
const sqlsOf = (router: ReturnType<typeof fakeRouter>) => router.query.mock.calls.map((c) => String(c[2]));

describe("previewLinkedDatabase", () => {
  it("lists user tables with counts, hiding internal tables", async () => {
    const out = await previewLinkedDatabase({ ...base, router: fakeRouter() });
    expect(out.tables.map((t) => t.name)).toEqual(["investors", "notes"]);
    expect(out.tables[0]).toMatchObject({ rowCount: 250 });
    expect(out.selectedTable).toBe("investors");
    expect(out.dbPath).toBe("/db/review.db");
  });

  it("fetches rows only for the selected table", async () => {
    const out = await previewLinkedDatabase({ ...base, router: fakeRouter() });
    expect(out.tables[0].rows).toHaveLength(3);
    expect(out.tables[1].rows).toEqual([]);
    const notes = await previewLinkedDatabase({ ...base, tableName: "notes", router: fakeRouter() });
    expect(notes.tables[0].rows).toEqual([]);
    expect(notes.tables[1].rows).toHaveLength(3);
  });

  it("pages with limit/offset, ordered by primary key", async () => {
    const router = fakeRouter();
    const out = await previewLinkedDatabase({ ...base, limit: 100, offset: 200, router });
    expect(out).toMatchObject({ limit: 100, offset: 200 });
    expect(sqlsOf(router).some((q) => q.includes('FROM "investors" ORDER BY "id" LIMIT 100 OFFSET 200'))).toBe(true);
  });

  it("uses a default page and clamps bad paging input", async () => {
    const router = fakeRouter();
    expect(await previewLinkedDatabase({ ...base, router })).toMatchObject({ limit: 50, offset: 0 });
    const clamped = await previewLinkedDatabase({ ...base, limit: 99999, offset: -4, router: fakeRouter() });
    expect(clamped).toMatchObject({ limit: 500, offset: 0 });
  });

  it("adds no ORDER BY for a table without a primary key", async () => {
    const router = fakeRouter();
    await previewLinkedDatabase({ ...base, tableName: "notes", router });
    const page = sqlsOf(router).find((q) => q.includes('FROM "notes"') && q.includes("LIMIT"));
    expect(page).toBeDefined();
    expect(page).not.toContain("ORDER BY");
  });

  it("reads only through the router with SELECTs", async () => {
    const router = fakeRouter();
    await previewLinkedDatabase({ ...base, router });
    expect(sqlsOf(router).every((q) => q.startsWith("SELECT"))).toBe(true);
  });

  it("rejects an alias that is not linked to the app", async () => {
    await expect(previewLinkedDatabase({ ...base, alias: "other", router: fakeRouter() })).rejects.toThrow(/not linked/);
  });

  it("falls back to the first table when tableName is unknown", async () => {
    const out = await previewLinkedDatabase({ ...base, tableName: "nope", router: fakeRouter() });
    expect(out.selectedTable).toBe("investors");
  });
});
