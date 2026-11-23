/**
 * Cloud-direct databases have no local file — the Turso primary is the only copy.
 * Schema checks (validate_app missing-table, data contracts, health counts) must
 * read the primary, not report every table missing because the path isn't on disk.
 *
 * Regression: a cloud agent (iMessage) run created `items` via migration, then
 * validate_app kept failing with "table items is missing from primary DB".
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("schema checks on cloud-direct databases", () => {
  let tmp: string;
  const dbId = "db-cd-schema";
  const localPath = () => path.join(tmp, "data", "databases", "grocery", "data.db");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cd-schema-"));
    const record = {
      dbId,
      localPath: localPath(),
      tursoShortName: "d-cd",
      label: "grocery",
      isolation: "shared",
      status: "active",
      syncMode: "cloud-direct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.doMock("../../src/gateway/services/DatabaseRegistryService.js", () => ({
      getDatabaseRegistryService: () => ({
        getById: (id: string) => (id === dbId ? record : undefined),
        getByPath: (p: string) =>
          path.normalize(p) === path.normalize(record.localPath) ? record : undefined,
      }),
      resolveTursoDatabaseNameForSource: () => "d-cd",
      tursoNameForRecord: () => "d-cd",
    }));
  });

  afterEach(async () => {
    const mod = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    mod.setCloudDirectClientFactoryForTests(null);
    vi.doUnmock("../../src/gateway/services/DatabaseRegistryService.js");
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function primaryWithItems() {
    const mod = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const primaryFile = path.join(tmp, "primary.db");
    mod.setCloudDirectClientFactoryForTests(async () =>
      createClient({ url: `file:${primaryFile}` }),
    );
    const client = createClient({ url: `file:${primaryFile}` });
    await client.executeMultiple(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, checked INTEGER);" +
        "INSERT INTO items (name, checked) VALUES ('Milk', 0), ('Eggs', 0);",
    );
    client.close();
  }

  const appFiles = (table: string) =>
    new Map([
      [
        "app.ts",
        `await fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM ${table}' }) });`,
      ],
    ]);

  it("validate_app: table on the primary is not reported missing (no local file)", async () => {
    await primaryWithItems();
    const { checkMissingTablesOnPrimaryDb } = await import(
      "../../src/gateway/services/appDatabaseEnforcement.js"
    );
    const issues = await checkMissingTablesOnPrimaryDb(localPath(), appFiles("items"), { dbId });
    expect(issues.filter((i) => i.rule === "db-table-missing-on-primary")).toEqual([]);
    expect(fs.existsSync(localPath())).toBe(false);
  });

  it("validate_app: a table really missing on the primary is still reported", async () => {
    await primaryWithItems();
    const { checkMissingTablesOnPrimaryDb } = await import(
      "../../src/gateway/services/appDatabaseEnforcement.js"
    );
    const issues = await checkMissingTablesOnPrimaryDb(localPath(), appFiles("chores"), { dbId });
    expect(issues.some((i) => i.rule === "db-table-missing-on-primary")).toBe(true);
  });

  it("schema, row counts and queries read the primary", async () => {
    await primaryWithItems();
    const reader = await import("../../src/gateway/services/jobs/registryDbSchemaReader.js");
    const input = { dbPath: localPath(), dbId };
    expect(await reader.registryDatabaseExists(input)).toBe(true);
    const read = await reader.readRegistryDatabaseSchema(input);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.schema.tables.has("items")).toBe(true);
      expect([...(read.schema.columnsByTable.get("items") ?? [])].sort()).toEqual([
        "checked",
        "id",
        "name",
      ]);
    }
    expect(await reader.countRowsInRegistryTable(input, "items")).toBe(2);
    const q = await reader.queryRegistryDatabase(input, "SELECT name FROM items ORDER BY id");
    expect(q?.rows.map((r) => r.name)).toEqual(["Milk", "Eggs"]);
  });

  it("local databases keep the file check", async () => {
    const reader = await import("../../src/gateway/services/jobs/registryDbSchemaReader.js");
    const other = path.join(tmp, "nope", "data.db");
    expect(await reader.registryDatabaseExists({ dbPath: other })).toBe(false);
    const read = await reader.readRegistryDatabaseSchema({ dbPath: other });
    expect(read.ok).toBe(false);
  });
});
